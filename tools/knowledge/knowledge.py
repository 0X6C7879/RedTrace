#!/usr/bin/env python3
"""Local-only index/matcher. Only the explicit `fetch` maintenance command uses a network."""
import argparse
import csv
import gzip
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import uuid
from cpe import CPE
import ijson
import yaml
from univers.versions import OpensslVersion, PypiVersion, MavenVersion, DebianVersion, RpmVersion
import semantic_version
from packaging.version import Version

SCHEMA = 1
VERSIONS = {"intdot": Version, "openssl": OpensslVersion, "pypi": PypiVersion, "maven": MavenVersion, "debian": DebianVersion, "rpm": RpmVersion}
PROTOCOLS = {"http", "tcp", "network", "ssl", "dns", "headless", "code", "javascript", "file", "websocket", "whois"}
ALIASES = {"apache": "http_server", "apache http server": "http_server", "apache httpd": "http_server", "apache tomcat": "tomcat", "apache http": "http_server", "httpd": "http_server", "http server": "http_server", "nextjs": "next.js", "nodejs": "node.js", "microsoft iis": "internet_information_services", "iis": "internet_information_services"}

# These explicit aliases include vendor identity; generic CPE product names remain ambiguous.
ALIAS_VENDORS = {name: "apache" for name in ["apache", "apache http server", "apache httpd", "apache http", "httpd", "apache tomcat", "tomcat"]}
ALIAS_VENDORS.update({"openssl": "openssl", "iis": "microsoft", "microsoft iis": "microsoft"})

def normalized(value):
    return re.sub(r"[ _-]+", " ", str(value).strip().lower())

def product(value):
    return normalized(ALIASES.get(normalized(value), value))

def sha(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""): h.update(part)
    return h.hexdigest()

def strings(value):
    if value is None: return []
    return list(dict.fromkeys(str(x).strip() for x in (value if isinstance(value, list) else str(value).split(",")) if str(x).strip()))

@lru_cache(maxsize=16384)
def cpe_fields(value):
    try: cpe = CPE(value)
    except (NotImplementedError, ValueError):
        # Some official Cisco records contain unescaped literal parentheses in the FS version field.
        repaired = re.sub(r"(?<!\\)([()])", r"\\\1", value)
        if repaired == value: raise
        cpe = CPE(repaired)
    result = {key: getattr(cpe, "get_" + key)()[0] for key in ["part", "vendor", "product", "version", "update", "edition", "language"]}
    if value.startswith("cpe:2.3:"):
        result.update({key: getattr(cpe, "get_" + method)()[0] for key, method in [("sw_edition", "software_edition"), ("target_sw", "target_software"), ("target_hw", "target_hardware"), ("other", "other")]})
    return {key: re.sub(r"\\([()])", r"\1", value) for key, value in result.items()}

def children(value):
    if isinstance(value, list):
        for child in value: yield from children(child)
    elif isinstance(value, dict):
        yield from value.get("cpeMatch", [])
        for key in ["nodes", "children"]: yield from children(value.get(key, []))

DDL = """
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE sources(name TEXT PRIMARY KEY,root TEXT NOT NULL,version TEXT,entries INTEGER NOT NULL,errors INTEGER NOT NULL);
CREATE TABLE artifacts(id TEXT PRIMARY KEY,source TEXT,key TEXT,path TEXT,sha256 TEXT,name TEXT,vendor TEXT,product TEXT,metadata TEXT);
CREATE INDEX artifact_product ON artifacts(product,vendor);
CREATE TABLE artifact_cves(cve TEXT,artifact TEXT,PRIMARY KEY(cve,artifact));
CREATE INDEX artifacts_by_cve ON artifact_cves(cve);
CREATE TABLE cves(id TEXT PRIMARY KEY,description TEXT,status TEXT,modified TEXT,configurations TEXT);
CREATE TABLE affected(cve TEXT,vendor TEXT,product TEXT);
CREATE INDEX affected_product ON affected(product,vendor);
CREATE INDEX affected_cve ON affected(cve);
CREATE VIRTUAL TABLE descriptions USING fts5(id UNINDEXED,text,tokenize='unicode61');
CREATE TABLE search_keys(id TEXT PRIMARY KEY,doc_rowid INTEGER NOT NULL);
"""

def source_version(root):
    for name in [".release", "VERSION"]:
        if (root / name).is_file(): return (root / name).read_text().strip()[:100]
    return "content-addressed snapshot"

def search_text(db, key, text):
    previous = db.execute("SELECT doc_rowid FROM search_keys WHERE id=?", (key,)).fetchone()
    if previous: db.execute("DELETE FROM descriptions WHERE rowid=?", previous)
    cursor = db.execute("INSERT INTO descriptions VALUES (?,?)", (key, text))
    db.execute("INSERT OR REPLACE INTO search_keys VALUES (?,?)", (key, cursor.lastrowid))

def add_artifact(db, source, key, file, staging, name, vendor, component, metadata):
    relative = file.relative_to(staging).as_posix(); digest = sha(file)
    aid = hashlib.sha256((source + ":" + key + ":" + relative + ":" + digest).encode()).hexdigest()
    previous = db.execute("SELECT metadata,name FROM artifacts WHERE id=?", (aid,)).fetchone()
    if previous:
        old = json.loads(previous[0])
        for field in ["cves", "tags", "prerequisites"]: metadata[field] = sorted(set(old.get(field, []) + metadata.get(field, [])))
        if previous[1] != name: metadata["alternateNames"] = sorted(set(old.get("alternateNames", []) + [previous[1], name]))
    db.execute("INSERT OR REPLACE INTO artifacts VALUES (?,?,?,?,?,?,?,?,?)", (aid, source, key, relative, digest, name, normalized(vendor), product(component), json.dumps(metadata)))
    db.executemany("INSERT OR IGNORE INTO artifact_cves VALUES (?,?)", [(cve, aid) for cve in metadata["cves"]])
    search_text(db, aid, " ".join([name, vendor, component] + metadata["tags"] + metadata["cves"]))

def build(args):
    root = Path(args.root).resolve(); generations = root / "generations"; generations.mkdir(parents=True, exist_ok=True)
    old_generation = generations / json.loads((root / "current.json").read_text())["generation"] if args.update_from else None
    generation = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    staging = generations / (".building-" + generation); staging.mkdir()
    diagnostics = []; warnings = []; db = None
    try:
        for name, value in [("nuclei-templates", args.nuclei), ("exploitdb", args.exploitdb), ("nvd", args.nvd)]:
            if value:
                source = Path(value).resolve()
                if not source.is_dir(): raise ValueError(name + " source directory missing: " + str(source))
                shutil.copytree(source, staging / name, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            elif old_generation: shutil.copytree(old_generation / name, staging / name)
            elif not args.allow_partial: raise ValueError("Required source missing: " + name)
            else: diagnostics.append({"source": name, "status": "missing"})
        database = staging / "vuln.sqlite"
        if old_generation: shutil.copyfile(old_generation / "vuln.sqlite", database)
        db = sqlite3.connect(database)
        if not old_generation: db.executescript(DDL)
        db.execute("DELETE FROM artifacts"); db.execute("DELETE FROM artifact_cves")
        db.execute("DELETE FROM descriptions WHERE id NOT LIKE 'CVE-%'")
        db.execute("DELETE FROM search_keys WHERE id NOT LIKE 'CVE-%'")
        source_rows = []
        templates = staging / "nuclei-templates"
        if templates.exists():
            count = errors = 0
            for file in sorted(templates.rglob("*.yaml")) + sorted(templates.rglob("*.yml")):
                if any(x.startswith(".") for x in file.relative_to(templates).parts): continue
                try:
                    data = yaml.safe_load(file.read_text())
                    if not isinstance(data, dict) or not isinstance(data.get("info"), dict) or not data.get("id"): continue
                    info = data["info"]; metadata = info.get("metadata") or {}; classification = info.get("classification") or {}
                    if not isinstance(metadata, dict) or not isinstance(classification, dict): raise ValueError("Invalid template metadata")
                    codes = sorted(set(re.findall(r"CVE-\d{4}-\d{4,}", " ".join(strings(classification.get("cve-id"))), re.I)))
                    if re.fullmatch(r"CVE-\d{4}-\d{4,}", str(data["id"]), re.I): codes.append(str(data["id"]).upper())
                    entry = {"protocols": sorted(PROTOCOLS.intersection(data)), "tags": strings(info.get("tags")), "cves": [x.upper() for x in codes],
                             "cpe": classification.get("cpe23"), "severity": info.get("severity", "unknown"), "prerequisites": strings(metadata.get("prerequisites")),
                             "version": metadata.get("version"), "references": strings(info.get("reference"))}
                    vendor = str(metadata.get("vendor") or ""); name = str(metadata.get("product") or "")
                    if entry["cpe"]:
                        try:
                            fields = cpe_fields(entry["cpe"]); vendor = vendor or fields["vendor"]; name = name or fields["product"]
                        except Exception: entry["cpeParseError"] = True
                    add_artifact(db, "nuclei", str(data["id"]), file, staging, str(info.get("name") or data["id"]), vendor, name, entry); count += 1
                except Exception as error:
                    errors += 1
                    if len(diagnostics) < 30: diagnostics.append({"source": "nuclei", "file": str(file.relative_to(staging)), "error": str(error)[:200]})
            if not count: raise ValueError("No valid Nuclei templates")
            source_rows.append(("nuclei-templates", "nuclei-templates", source_version(templates), count, errors))
        edb = staging / "exploitdb"
        if edb.exists():
            if args.searchsploit: shutil.copyfile(args.searchsploit, edb / "searchsploit")
            if not (edb / "searchsploit").is_file(): diagnostics.append({"source": "exploitdb", "status": "SearchSploit missing; structured fallback only"})
            count = errors = 0
            with (edb / "files_exploits.csv").open(newline="", encoding="utf8") as stream:
                for row in csv.DictReader(stream):
                    try:
                        file = (edb / row["file"]).resolve()
                        if not file.is_relative_to(edb.resolve()) or not file.is_file(): raise ValueError("PoC missing or outside source root")
                        codes = sorted(set(re.findall(r"CVE-\d{4}-\d{4,}", row.get("codes", ""), re.I)))
                        entry = {"cves": [x.upper() for x in codes], "platform": row.get("platform"), "type": row.get("type"), "verified": row.get("verified"),
                                 "protocols": [], "tags": strings(row.get("tags")), "prerequisites": []}
                        add_artifact(db, "exploitdb", row["id"], file, staging, row["description"], "", "", entry); count += 1
                    except Exception as error:
                        errors += 1
                        if len(diagnostics) < 30: diagnostics.append({"source": "exploitdb", "error": str(error)[:200]})
            if not count: raise ValueError("ExploitDB CSV has no usable entries")
            source_rows.append(("exploitdb", "exploitdb", source_version(edb), db.execute("SELECT count(*) FROM artifacts WHERE source='exploitdb'").fetchone()[0], errors))
        nvd = staging / "nvd"
        if nvd.exists():
            count = errors = 0
            if args.update_from:
                feeds = []
                for value in args.update_from:
                    source = Path(value).resolve(); destination = nvd / source.name
                    shutil.copyfile(source, destination); feeds.append(destination)
            else: feeds = sorted(nvd.glob("*.json")) + sorted(nvd.glob("*.json.gz"))
            if not feeds: raise ValueError("No NVD 2.0 JSON feeds")
            for file in feeds:
                opener = gzip.open if str(file).endswith(".gz") else open
                with opener(file, "rb") as stream:
                    for wrapper in ijson.items(stream, "vulnerabilities.item", use_float=True):
                        cve = wrapper.get("cve")
                        if not isinstance(cve, dict) or not re.fullmatch(r"CVE-\d{4}-\d{4,}", str(cve.get("id", ""))): raise ValueError("Invalid NVD CVE record")
                        cid = cve["id"]; configurations = cve.get("configurations", [])
                        description = next((x["value"] for x in cve.get("descriptions", []) if x.get("lang") == "en"), "")
                        db.execute("INSERT OR REPLACE INTO cves VALUES (?,?,?,?,?)", (cid, description, cve.get("vulnStatus", "unknown"), cve.get("lastModified", ""), json.dumps(configurations)))
                        db.execute("DELETE FROM affected WHERE cve=?", (cid,)); search_text(db, cid, description)
                        seen = set()
                        for match in children(configurations):
                            try:
                                f = cpe_fields(match["criteria"])
                                if re.search(r"(?<!\\)[()]", match["criteria"]): warnings.append({"source": "nvd", "cve": cid, "criteria": match["criteria"], "repair": "escaped literal parentheses for CPE parser; original configuration retained"})
                                if match.get("vulnerable") and (f["vendor"], f["product"]) not in seen:
                                    db.execute("INSERT INTO affected VALUES (?,?,?)", (cid, normalized(f["vendor"]), product(f["product"]))); seen.add((f["vendor"], f["product"]))
                            except Exception as error:
                                errors += 1
                                if len(diagnostics) < 30: diagnostics.append({"source": "nvd", "cve": cid, "error": str(error)[:200]})
                        count += 1
                        if count % 2000 == 0: db.commit()
            if not count: raise ValueError("NVD feed contains no CVEs")
            source_rows.append(("nvd", "nvd", "NVD-2.0", db.execute("SELECT count(*) FROM cves").fetchone()[0], errors))
        partial = bool(diagnostics) or len(source_rows) != 3
        if partial and not args.allow_partial: raise ValueError("Incomplete data build: " + json.dumps(diagnostics[:10]))
        db.executemany("INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?)", source_rows)
        db.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [("schema", str(SCHEMA)), ("generation", generation), ("created", str(time.time())), ("partial", str(partial).lower()), ("diagnostics", json.dumps(diagnostics))]); db.commit()
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok": raise ValueError("SQLite integrity check failed")
        db.close(); db = None
        final = generations / generation; staging.rename(final)
        manifest = {"schema": SCHEMA, "generation": generation, "created": time.time(), "partial": partial, "sources": [{"name": x[0], "version": x[2], "entries": x[3], "errors": x[4]} for x in source_rows], "databaseSha256": sha(final / "vuln.sqlite"), "diagnostics": diagnostics,
                    "searchsploitSha256": sha(final / "exploitdb/searchsploit") if (final / "exploitdb/searchsploit").is_file() else None,
                    "fingerprintsSha256": sha(final / "fingerprints.json") if (final / "fingerprints.json").is_file() else None, "warnings": warnings}
        (final / "manifest.json").write_text(json.dumps(manifest, indent=2))
        temp = root / (".current-" + uuid.uuid4().hex); temp.write_text(json.dumps(manifest)); os.replace(temp, root / "current.json")
        print(json.dumps(manifest))
    except BaseException:
        if db is not None: db.close()
        shutil.rmtree(staging, ignore_errors=True)
        raise

@lru_cache(maxsize=16384)
def compare(left, right, scheme=None):
    if scheme is None or scheme == "intdot":
        if not re.fullmatch(r"\d+(?:\.\d+)*", left) or not re.fullmatch(r"\d+(?:\.\d+)*", right): return None
        scheme = "intdot"
    try:
        if scheme == "semver": a, b = semantic_version.Version(left), semantic_version.Version(right)
        elif scheme in VERSIONS: a, b = VERSIONS[scheme](left), VERSIONS[scheme](right)
        else: return None
        return (a > b) - (a < b)
    except Exception: return None

def version_match(rule, observation, cpe_version):
    version = observation.get("version")
    if not version: return None
    if cpe_version == "-": return version == "-"
    result = True
    for field, operator in [("versionStartIncluding", ">="), ("versionStartExcluding", ">"), ("versionEndIncluding", "<="), ("versionEndExcluding", "<")]:
        if field not in rule: continue
        cmp = compare(version, str(rule[field]), observation.get("versionScheme"))
        if cmp is None: result = None; continue
        if not {">=": cmp >= 0, ">": cmp > 0, "<=": cmp <= 0, "<": cmp < 0}[operator]: return False
    if cpe_version not in ["*", "-"]:
        if version == cpe_version: return result
        cmp = compare(version, cpe_version, observation.get("versionScheme"))
        if cmp is None: return None
        if cmp != 0: return False
    return result

def leaf(rule, observations):
    try: fields = cpe_fields(rule["criteria"])
    except Exception: return None
    answers = []
    for observation in observations:
        try: observed_cpe = cpe_fields(observation["cpe"]) if observation.get("cpe") else {}
        except Exception: observed_cpe = {}
        name = product(observed_cpe.get("product") or observation.get("product", observation.get("component", "")))
        if name != product(fields["product"]): continue
        vendor = normalized(observation.get("vendor", observed_cpe.get("vendor", "")))
        if fields["vendor"] not in ["*", "-"] and vendor and vendor != normalized(fields["vendor"]): continue
        value = version_match(rule, observation, fields["version"])
        if fields["vendor"] not in ["*", "-"] and not vendor and value is not False: value = None
        for key in ["part", "update", "edition", "language", "sw_edition", "target_sw", "target_hw", "other"]:
            if fields.get(key, "*") != "*":
                observed = observation.get(key, observed_cpe.get(key))
                if observed is None or observed == "*": value = None if value is not False else False
                elif observed != fields[key]: value = False
        answers.append(value)
    if not answers: return None
    return True if True in answers else None if None in answers else False

def tri(values, operator):
    if not values: return None
    if operator == "AND": return False if False in values else None if None in values else True
    if operator == "OR": return True if True in values else None if None in values else False
    return None

def evaluate(node, observations):
    if isinstance(node, list): return tri([evaluate(x, observations) for x in node], "OR")
    if not isinstance(node, dict): return None
    values = [leaf(x, observations) for x in node.get("cpeMatch", [])] + [evaluate(x, observations) for x in node.get("nodes", []) + node.get("children", [])]
    value = tri(values, node.get("operator", "OR"))
    return (not value if value is not None else None) if node.get("negate") else value

def artifact_result(row, generation):
    metadata = json.loads(row["metadata"])
    metadata.pop("offline", None)  # Older generations may contain verifier metadata; this tool only retrieves data.
    return {**metadata, "id": row["id"], "source": row["source"], "key": row["key"], "path": str(generation / row["path"]), "sha256": row["sha256"], "name": row["name"], "vendor": row["vendor"], "component": row["product"]}

def has_negation(value):
    if isinstance(value, list): return any(has_negation(item) for item in value)
    return isinstance(value, dict) and (bool(value.get("negate")) or any(has_negation(value.get(key, [])) for key in ["nodes", "children"]))

def affected_versions(configurations, observations):
    ranges = []
    for rule in children(configurations):
        if not rule.get("vulnerable"): continue
        try: fields = cpe_fields(rule["criteria"])
        except Exception: continue
        if observations:
            matching = [item for item in observations if product(item.get("product") or item.get("component", "")) == product(fields["product"]) and (not item.get("vendor") or normalized(item["vendor"]) == normalized(fields["vendor"]))]
            if not matching: continue
        else: matching = []
        entry = {"cpe": rule["criteria"], "vendor": fields["vendor"], "product": fields["product"], "version": fields["version"]}
        entry.update({key: rule[key] for key in ["versionStartIncluding", "versionStartExcluding", "versionEndIncluding", "versionEndExcluding"] if key in rule})
        values = [version_match(rule, item, fields["version"]) for item in matching]
        entry["versionMatch"] = "affected" if True in values else "unknown" if not values or None in values else "not_affected"
        if entry not in ranges: ranges.append(entry)
    states = [item["versionMatch"] for item in ranges]
    ranges.sort(key=lambda item: (item["versionMatch"] != "affected", item["versionMatch"] != "unknown", item["cpe"]))
    return ("unknown" if has_negation(configurations) else "affected" if "affected" in states else "unknown" if not states or "unknown" in states else "not_affected"), ranges

def query(args):
    request = json.load(sys.stdin); database = Path(args.database).resolve(); generation = database.parent
    for key, maximum in [("query", 300), ("component", 200), ("vendor", 200), ("version", 100), ("cpe", 4096)]:
        if key in request and (not isinstance(request[key], str) or not 0 < len(request[key]) <= maximum): raise ValueError("Invalid " + key)
    offset = int(request.get("offset", 0)); limit = int(request.get("limit", 5))
    if offset < 0 or not 1 <= limit <= 50: raise ValueError("Invalid pagination")
    text = request.get("query", ""); codes = set(x.upper() for x in re.findall(r"\bCVE-\d{4}-\d{4,}\b", text, re.I))
    component = request.get("component") or (text if not codes else "")
    version = request.get("version")
    if component and not version:
        parsed = re.fullmatch(r"(.+?)\s+v?(\d+(?:\.\d+)+(?:[a-zA-Z][\w.-]*|[-+][\w.]+)?)", component)
        if parsed: component, version = parsed.groups()
    observation = {"component": component, "version": version, "vendor": request.get("vendor") or ALIAS_VENDORS.get(normalized(component)), "versionScheme": request.get("version_scheme") or ("openssl" if normalized(component) == "openssl" else None)}
    if request.get("cpe"):
        canonical = cpe_fields(request["cpe"])
        observation.update({key: value for key, value in canonical.items() if value not in ["*", "-"]})
        observation["component"] = canonical["product"]; observation["cpe"] = request["cpe"]
    observations = [observation] if observation["component"] else []
    if not text and not observations: raise ValueError("Provide query, component or cpe")
    db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True); db.row_factory = sqlite3.Row
    meta = dict(db.execute("SELECT key,value FROM meta"))
    if meta.get("schema") != str(SCHEMA): raise ValueError("Unsupported index schema; rebuild offline data")
    ids = set(codes); artifacts = set(); diagnostics = []
    if codes:
        # CVE identifiers are exact keys, not OR-ed with description tokens.
        for cid in codes:
            artifacts.update(x[0] for x in db.execute("SELECT artifact FROM artifact_cves WHERE cve=?", (cid,)))
    else:
        name = product(observation["component"]); vendor = normalized(observation.get("vendor") or "")
        ids.update(x[0] for x in db.execute("SELECT DISTINCT cve FROM affected WHERE product=? AND (?='' OR vendor=?)", (name, vendor, vendor)))
        artifacts.update(x[0] for x in db.execute("SELECT id FROM artifacts WHERE product=? AND (?='' OR vendor=?)", (name, vendor, vendor)))
        if not ids and not artifacts:
            terms = re.findall(r"[\w.-]{2,}", component or text)[:16]
            if terms:
                expression = " AND ".join('"' + x.replace('"', '""') + '"' for x in terms)
                for row in db.execute("SELECT id FROM descriptions WHERE descriptions MATCH ?", (expression,)):
                    (ids if row[0].startswith("CVE-") else artifacts).add(row[0])
        for aid in artifacts: ids.update(x[0] for x in db.execute("SELECT cve FROM artifact_cves WHERE artifact=?", (aid,)))
    selected = request.get("candidate_id")
    if selected:
        ids.intersection_update({selected})
        artifacts = {aid for aid in artifacts if db.execute("SELECT source || ':' || key FROM artifacts WHERE id=?", (aid,)).fetchone()[0] == selected}
    results = []
    # Evaluate version/configuration before pagination; materialize source files only for the returned page.
    for cid in sorted(ids):
        row = db.execute("SELECT * FROM cves WHERE id=?", (cid,)).fetchone()
        if not row and not db.execute("SELECT 1 FROM artifact_cves WHERE cve=?", (cid,)).fetchone(): continue
        configurations = json.loads(row["configurations"]) if row else []
        version_status, ranges = affected_versions(configurations, observations)
        applies = evaluate(configurations, observations) if row and observations else None
        if row and row["status"].lower() == "rejected": applies = False; version_status = "not_affected"
        if not codes and not request.get("include_excluded") and (applies is False or version_status == "not_affected"): continue
        results.append({"candidateId": cid, "kind": "vulnerability", "cves": [cid], "name": row["description"][:260] if row else cid,
                        "status": "candidate" if applies is True else "not_applicable" if applies is False else "unknown",
                        "versionMatch": version_status, "affectedVersions": ranges[:20], "affectedVersionCount": len(ranges), "modified": row["modified"] if row else "",
                        "unresolved": [] if applies is not None else ["Version match is not proof; product/vendor/version or environment may be incomplete"], "validated": False})
    for aid in sorted(artifacts):
        row = db.execute("SELECT * FROM artifacts WHERE id=?", (aid,)).fetchone()
        if db.execute("SELECT 1 FROM artifact_cves WHERE artifact=?", (aid,)).fetchone(): continue
        results.append({"candidateId": row["source"] + ":" + row["key"], "_artifact": aid, "kind": "vulnerability", "name": row["name"], "status": "unknown",
                        "versionMatch": "unknown", "affectedVersions": [], "cves": [], "modified": "", "validated": False, "unresolved": ["No authoritative affected-version data"]})
    results.sort(key=lambda x: (x["versionMatch"] == "affected", x["modified"], x["candidateId"]), reverse=True)
    page = results[offset:offset + limit]
    for candidate in page:
        cid = candidate["candidateId"]
        if "_artifact" in candidate:
            sources = [artifact_result(db.execute("SELECT * FROM artifacts WHERE id=?", (candidate.pop("_artifact"),)).fetchone(), generation)]
        else:
            sources = [artifact_result(x, generation) for x in db.execute("SELECT a.* FROM artifacts a JOIN artifact_cves r ON r.artifact=a.id WHERE r.cve=? ORDER BY a.source,a.key", (cid,))]
            if db.execute("SELECT 1 FROM cves WHERE id=?", (cid,)).fetchone(): sources.append({"source": "nvd", "cve": cid, "database": str(database), "reference": "https://nvd.nist.gov/vuln/detail/" + cid, "modified": candidate["modified"]})
        # Bounded previews; knowledge_read retains every source and the full configurations.
        candidate["sourceCount"] = len(sources); candidate["sources"] = sources[:20]
        for source in candidate["sources"]: source.pop("references", None)
    print(json.dumps({"results": page, "total": len(results), "nextOffset": offset + limit if offset + limit < len(results) else None,
                      "generation": meta["generation"], "partial": meta.get("partial") == "true", "diagnostics": json.loads(meta.get("diagnostics", "[]")) + diagnostics,
                      "sources": [dict(x) for x in db.execute("SELECT * FROM sources")], "input": observation if observations else {"query": text}}))
    db.close()

def fetch(args):
    import urllib.request
    directory = Path(args.directory).resolve(); directory.mkdir(parents=True, exist_ok=True)
    for year in args.years:
        if year != "modified" and not re.fullmatch(r"20\d{2}", year): raise ValueError("Invalid feed year")
        base = "https://nvd.nist.gov/feeds/json/cve/2.0/nvdcve-2.0-" + year
        metadata = urllib.request.urlopen(base + ".meta", timeout=60).read().decode(); fields = dict(x.split(":", 1) for x in metadata.splitlines() if ":" in x); expected = fields.get("sha256", "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{64}", expected): raise ValueError("NVD META missing SHA256")
        destination = directory / ("nvdcve-2.0-" + year + ".json.gz"); old = destination.with_suffix(destination.suffix + ".meta")
        if destination.exists() and old.exists() and old.read_text() == metadata: print(json.dumps({"feed": year, "status": "unchanged"})); continue
        temp = destination.with_suffix(destination.suffix + ".part")
        try:
            with urllib.request.urlopen(base + ".json.gz", timeout=120) as response, temp.open("wb") as output: shutil.copyfileobj(response, output)
            h = hashlib.sha256()
            with gzip.open(temp, "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""): h.update(chunk)
            if h.hexdigest() != expected: raise ValueError("NVD uncompressed SHA256 mismatch")
            temp.replace(destination); old.write_text(metadata); print(json.dumps({"feed": year, "status": "downloaded", "sha256": expected}))
        finally: temp.unlink(missing_ok=True)

def import_package(args):
    import tarfile
    root = Path(args.root).resolve(); root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".import-", dir=root) as temp:
        staging = Path(temp)
        with tarfile.open(args.package, "r:gz") as archive:
            entries = archive.getmembers()
            if sum(x.size for x in entries) > 20 * 1024**3 or len(entries) > 200000: raise ValueError("Offline package exceeds import limits")
            for entry in entries:
                destination = (staging / entry.name).resolve()
                if not destination.is_relative_to(staging) or not (entry.isfile() or entry.isdir()): raise ValueError("Unsafe archive member")
            archive.extractall(staging, filter="data")
        manifest = json.loads((staging / "current.json").read_text())
        if manifest.get("schema") != SCHEMA or not re.fullmatch(r"[A-Za-z0-9_-]+", manifest.get("generation", "")): raise ValueError("Invalid package manifest")
        if manifest.get("partial") and not args.allow_partial: raise ValueError("Partial package refused unless explicitly requested")
        generation = staging / "generations" / manifest["generation"]
        database = generation / "vuln.sqlite"
        if sha(database) != manifest["databaseSha256"]: raise ValueError("Offline package database hash mismatch")
        db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        try:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok": raise ValueError("Offline package SQLite damaged")
            for file, digest in db.execute("SELECT path,sha256 FROM artifacts"):
                source = (generation / file).resolve()
                if not source.is_relative_to(generation) or not source.is_file() or sha(source) != digest: raise ValueError("Offline package source hash mismatch: " + file)
        finally: db.close()
        for name, key in [("exploitdb/searchsploit", "searchsploitSha256"), ("fingerprints.json", "fingerprintsSha256")]:
            if manifest.get(key) and sha(generation / name) != manifest[key]: raise ValueError("Offline package runtime data hash mismatch: " + name)
        destination = root / "generations" / manifest["generation"]; destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            if sha(destination / "vuln.sqlite") != manifest["databaseSha256"]: raise ValueError("Existing generation collision")
        else: generation.rename(destination)
        pointer = root / (".current-" + uuid.uuid4().hex); pointer.write_text(json.dumps(manifest)); pointer.replace(root / "current.json")
        print(json.dumps({"imported": manifest["generation"], "root": str(root), "network": "not used"}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); commands = parser.add_subparsers(dest="command", required=True)
    builder = commands.add_parser("build"); builder.add_argument("--root", required=True)
    for name in ["nuclei", "exploitdb", "nvd", "searchsploit"]: builder.add_argument("--" + name)
    builder.add_argument("--allow-partial", action="store_true"); builder.add_argument("--update-from", nargs="+")
    search = commands.add_parser("query"); search.add_argument("--database", required=True)
    downloader = commands.add_parser("fetch"); downloader.add_argument("--directory", required=True); downloader.add_argument("--years", nargs="+", required=True)
    importer = commands.add_parser("import"); importer.add_argument("--root", required=True); importer.add_argument("--package", required=True); importer.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()
    try: {"build": build, "query": query, "fetch": fetch, "import": import_package}[args.command](args)
    except Exception as error: print(json.dumps({"error": str(error)}), file=sys.stderr); sys.exit(1)
