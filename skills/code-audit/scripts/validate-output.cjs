#!/usr/bin/env node

/**
 * Validates api-audit / mr-review / report-review JSON output against output-schema.json.
 * Usage: node validate-output.cjs <path-to-output.json> [mode]
 *   mode: "api-audit" | "mr-review" | "report-review" (default: api-audit)
 *
 * The validation rules live in output-schema.json — the single source of truth.
 * This script reads that schema at runtime and interprets the subset of JSON
 * Schema it uses: type (object|array|string|integer|number|boolean),
 * properties, required, additionalProperties:false, enum, const, items, minItems.
 *
 * $ref within the schema doc is resolved locally (same-file refs only).
 *
 * Semantic layer (constraints the schema subset can't express):
 *   - conclusion=vulnerability findings MUST have data_flow and example_payload
 *   - passed_checks[*].reason MUST start with [FP-x.y] or [FP-NONE]
 *   - conclusion severity ceiling (risk-b ≤ high, risk-a ≤ medium, unknown ≤ low)
 *   - report-review summary.upgraded + downgraded + unchanged == total_reviewed
 *   - findings.vulnerabilities_count == actual vulnerabilities array length
 *   - findings.risks_count == actual risks array length
 *
 * Zero dependencies. Exits 0 on success, 1 on validation failure.
 */

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const mode = process.argv[3] || "api-audit";

if (!file) {
	console.error("Usage: node validate-output.cjs <path-to-output.json> [mode]");
	console.error("  mode: api-audit | mr-review | report-review (default: api-audit)");
	process.exit(1);
}

const validModes = ["api-audit", "mr-review", "report-review"];
if (!validModes.includes(mode)) {
	console.error(`Invalid mode "${mode}". Expected one of: ${validModes.join(", ")}`);
	process.exit(1);
}

const schemaPath = path.join(__dirname, "output-schema.json");
let doc;
try {
	doc = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
} catch (e) {
	console.error(`Failed to load schema from ${schemaPath}:`, e.message);
	process.exit(1);
}

let output;
try {
	output = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
	console.error("Failed to parse JSON:", e.message);
	process.exit(1);
}

// --- $ref resolver (same-file only: "#/name" or bare "name") ---
function resolveRef(ref) {
	if (typeof ref !== "string") return null;
	let parts;
	if (ref.startsWith("#/")) {
		parts = ref.slice(2).split("/");
	} else if (!ref.includes("/") && !ref.startsWith("#")) {
		// bare name → top-level key in the schema doc
		parts = [ref];
	} else {
		return null;
	}
	let cur = doc;
	for (const p of parts) {
		if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
		else return null;
	}
	return cur;
}

function deref(schema) {
	if (!schema || typeof schema !== "object") return schema;
	if (Object.prototype.hasOwnProperty.call(schema, "$ref")) {
		return deref(resolveRef(schema.$ref));
	}
	return schema;
}

// --- Generic JSON Schema interpreter ---
function typeOf(v) {
	if (Array.isArray(v)) return "array";
	if (v === null) return "null";
	return typeof v; // object | string | number | boolean
}

const TYPE_CHECK = {
	object: (v) => typeOf(v) === "object" && v !== null,
	array: (v) => Array.isArray(v),
	string: (v) => typeof v === "string",
	integer: (v) => typeof v === "number" && Number.isInteger(v),
	number: (v) => typeof v === "number",
	boolean: (v) => typeof v === "boolean",
};

function validate(value, schema, p, errors) {
	schema = deref(schema);
	if (!schema) {
		errors.push(`${p}: could not resolve schema`);
		return;
	}

	// const
	if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
		errors.push(`${p}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}

	// enum
	if (schema.enum && !schema.enum.includes(value)) {
		const allowed = schema.enum.map((v) => JSON.stringify(v)).join(", ");
		errors.push(`${p}: invalid value ${JSON.stringify(value)} (expected one of ${allowed})`);
	}

	// type (supports array of types)
	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const ok = types.some((t) => TYPE_CHECK[t] && TYPE_CHECK[t](value));
		if (!ok) {
			errors.push(`${p}: expected ${types.join("|")}, got ${typeOf(value)}`);
			return; // deeper checks meaningless if wrong type
		}
	}

	switch (typeOf(value)) {
		case "object": {
			for (const req of schema.required || []) {
				if (!(req in value)) errors.push(`${p}: missing required field "${req}"`);
			}
			for (const key of Object.keys(value)) {
				if (schema.properties && key in schema.properties) {
					validate(value[key], schema.properties[key], `${p}.${key}`, errors);
				} else if (schema.additionalProperties === false) {
					errors.push(`${p}: unexpected field "${key}"`);
				}
			}
			break;
		}
		case "array": {
			if (typeof schema.minItems === "number" && value.length < schema.minItems) {
				errors.push(`${p}: must have at least ${schema.minItems} item(s), got ${value.length}`);
			}
			if (schema.items) {
				value.forEach((el, i) => validate(el, schema.items, `${p}[${i}]`, errors));
			}
			break;
		}
		default:
			break;
	}
}

function collect(value, schema, p) {
	const errors = [];
	validate(value, schema, p, errors);
	return errors;
}

// --- Semantic layer ---
const SEVERITY_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CONCLUSION_CEILING = {
	"vulnerability": "critical",
	"risk-b": "high",
	"risk-a": "medium",
	"unknown": "low",
	"safe": "info",
};

function fpTagOk(reason) {
	if (typeof reason !== "string") return false;
	return /^\[FP-[\d.]+\]/.test(reason) || reason.startsWith("[FP-NONE]");
}

function semanticFindings(findings, pPrefix, errors) {
	const checkFinding = (f, i, bucketPrefix) => {
		const p = `${bucketPrefix}[${i}]`;
		if (!f) return;
		// enum checks (sourced from output-schema.json top-level *_enum arrays;
		// category_enum mirrors references/common/category-enum.md)
		if (Array.isArray(doc.category_enum) && f.category && !doc.category_enum.includes(f.category)) {
			errors.push(`${p}.category: "${f.category}" is not a valid category enum (see category-enum.md)`);
		}
		if (Array.isArray(doc.conclusion_enum) && f.conclusion && !doc.conclusion_enum.includes(f.conclusion)) {
			errors.push(`${p}.conclusion: invalid value "${f.conclusion}" (expected one of ${doc.conclusion_enum.join(", ")})`);
		}
		if (Array.isArray(doc.severity_enum) && f.severity && !doc.severity_enum.includes(f.severity)) {
			errors.push(`${p}.severity: invalid value "${f.severity}" (expected one of ${doc.severity_enum.join(", ")})`);
		}
		// conclusion=vulnerability must have data_flow + example_payload
		if (f.conclusion === "vulnerability") {
			if (!f.data_flow) errors.push(`${p}: conclusion=vulnerability requires "data_flow"`);
			if (!Array.isArray(f.example_payload) || f.example_payload.length === 0) {
				errors.push(`${p}: conclusion=vulnerability requires non-empty "example_payload"`);
			}
		}
		// severity ceiling by conclusion
		const ceil = CONCLUSION_CEILING[f.conclusion];
		if (ceil && f.severity && SEVERITY_ORDER[f.severity] !== undefined &&
			SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[ceil]) {
			errors.push(`${p}: conclusion=${f.conclusion} severity must be ≤ ${ceil}, got ${f.severity}`);
		}
		// file_path must be relative (no leading /)
		if (Array.isArray(f.affected_locations)) {
			f.affected_locations.forEach((loc, j) => {
				if (loc && typeof loc.file_path === "string" && loc.file_path.startsWith("/")) {
					errors.push(`${p}.affected_locations[${j}].file_path: must be relative path, got absolute "${loc.file_path}"`);
				}
			});
		}
	};

	(findings.vulnerabilities || []).forEach((f, i) => checkFinding(f, i, `${pPrefix}.vulnerabilities`));
	(findings.risks || []).forEach((f, i) => checkFinding(f, i, `${pPrefix}.risks`));

	// passed_checks reason tag + type enum
	(findings.passed_checks || []).forEach((pc, i) => {
		if (pc) {
			if (!fpTagOk(pc.reason)) {
				errors.push(`${pPrefix}.passed_checks[${i}].reason: must start with [FP-x.y] or [FP-NONE], got "${pc.reason}"`);
			}
			if (Array.isArray(doc.category_enum) && pc.type && !doc.category_enum.includes(pc.type)) {
				errors.push(`${pPrefix}.passed_checks[${i}].type: "${pc.type}" is not a valid category enum`);
			}
		}
	});

	// count consistency (only for api-audit-style summaries attached elsewhere)
}

// --- Run ---
let errorCount = 0;

if (mode === "report-review") {
	// top-level schema: report_review_top_schema, but updated_result inside each review
	// is itself api-audit-shaped. Validate top structurally, then each updated_result.
	const topSchema = doc.report_review_top_schema;
	const errs = collect(output, topSchema, "root");
	for (const m of errs) console.error("  ERROR:", m);
	errorCount += errs.length;

	const reviews = (output && Array.isArray(output.reviews)) ? output.reviews : [];
	reviews.forEach((rv, i) => {
		const p = `root.reviews[${i}]`;
		if (rv && rv.changed === true) {
			if (!rv.updated_result) {
				console.error(`  ERROR: ${p}: changed=true requires "updated_result"`);
				errorCount++;
				return;
			}
			const urErrs = collect(rv.updated_result, doc.api_audit_top_schema, `${p}.updated_result`);
			for (const m of urErrs) console.error("  ERROR:", m);
			errorCount += urErrs.length;
			if (rv.updated_result.findings) {
				const se = [];
				semanticFindings(rv.updated_result.findings, `${p}.updated_result.findings`, se);
				for (const m of se) console.error("  ERROR:", m);
				errorCount += se.length;
			}
			// count consistency
			if (rv.updated_result.summary && rv.updated_result.findings) {
				const vCnt = (rv.updated_result.findings.vulnerabilities || []).length;
				const rCnt = (rv.updated_result.findings.risks || []).length;
				if (rv.updated_result.summary.vulnerabilities_count !== vCnt) {
					console.error(`  ERROR: ${p}.updated_result.summary.vulnerabilities_count=${rv.updated_result.summary.vulnerabilities_count} but actual=${vCnt}`);
					errorCount++;
				}
				if (rv.updated_result.summary.risks_count !== rCnt) {
					console.error(`  ERROR: ${p}.updated_result.summary.risks_count=${rv.updated_result.summary.risks_count} but actual=${rCnt}`);
					errorCount++;
				}
			}
		}
	});

	// report-review summary arithmetic
	if (output && output.summary) {
		const s = output.summary;
		const sum = (s.upgraded || 0) + (s.downgraded || 0) + (s.unchanged || 0);
		if (s.total_reviewed !== undefined && sum !== s.total_reviewed) {
			console.error(`  ERROR: root.summary: upgraded(${s.upgraded})+downgraded(${s.downgraded})+unchanged(${s.unchanged})=${sum} != total_reviewed(${s.total_reviewed})`);
			errorCount++;
		}
	}
} else {
	// api-audit / mr-review share the same top schema
	const topSchema = doc.api_audit_top_schema;
	const errs = collect(output, topSchema, "root");
	for (const m of errs) console.error("  ERROR:", m);
	errorCount += errs.length;

	if (output && output.findings) {
		const se = [];
		semanticFindings(output.findings, "root.findings", se);
		for (const m of se) console.error("  ERROR:", m);
		errorCount += se.length;
	}
	// count consistency
	if (output && output.summary && output.findings) {
		const vCnt = (output.findings.vulnerabilities || []).length;
		const rCnt = (output.findings.risks || []).length;
		if (output.summary.vulnerabilities_count !== vCnt) {
			console.error(`  ERROR: root.summary.vulnerabilities_count=${output.summary.vulnerabilities_count} but actual=${vCnt}`);
			errorCount++;
		}
		if (output.summary.risks_count !== rCnt) {
			console.error(`  ERROR: root.summary.risks_count=${output.summary.risks_count} but actual=${rCnt}`);
			errorCount++;
		}
	}
}

console.log();
if (errorCount === 0) {
	console.log(`PASS: ${file} valid (mode=${mode})`);
} else {
	console.error(`FAIL: ${errorCount} error(s) in ${file} (mode=${mode})`);
	process.exit(1);
}
