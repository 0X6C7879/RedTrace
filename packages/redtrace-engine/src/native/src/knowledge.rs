use napi_derive::napi;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn milliseconds() -> Result<u128> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
}

fn excluded(relative: &Path) -> bool {
    relative.to_string_lossy().split(['/', '\\']).any(|part| {
        let lower = part.to_ascii_lowercase();
        let suffix = |value: &str| value.is_empty() || value.starts_with(['.', '_', '-']);
        if [
            ".git",
            "node_modules",
            ".redtrace",
            "solution",
            "answer",
            "flag",
            "secret",
            "credential",
        ]
        .iter()
        .any(|prefix| lower.strip_prefix(prefix).is_some_and(suffix))
        {
            return true;
        }
        let Some(rest) = lower.strip_prefix("write") else {
            return false;
        };
        if rest.strip_prefix("up").is_some_and(suffix) {
            return true;
        }
        rest.chars()
            .next()
            .filter(|ch| !matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .is_some_and(|ch| rest[ch.len_utf8()..].strip_prefix("up").is_some_and(suffix))
    })
}

fn entries(directory: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut values = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    values.sort_by_key(|entry| entry.file_name());
    Ok(values)
}

fn collect(root: &Path, output: &mut Vec<PathBuf>, maximum: usize) -> bool {
    let mut pending = vec![root.to_path_buf()];
    let mut scanned = 0;
    let start = output.len();
    while !pending.is_empty() && output.len() - start < maximum && scanned < maximum * 8 {
        let directory = pending.pop().expect("checked nonempty directory stack");
        let Ok(values) = entries(&directory) else {
            continue;
        };
        for entry in values {
            scanned += 1;
            if scanned >= maximum * 8 {
                break;
            }
            let full = entry.path();
            if excluded(
                full.strip_prefix(root)
                    .expect("directory entries stay beneath their scan root"),
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(full);
            } else if kind.is_file()
                && [".md", ".txt", ".rst", ".yaml", ".yml", ".json"]
                    .iter()
                    .any(|suffix| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .to_ascii_lowercase()
                            .ends_with(suffix)
                    })
            {
                if fs::metadata(&full).is_ok_and(|state| state.len() <= 256 * 1024) {
                    output.push(full);
                }
                if output.len() - start >= maximum {
                    break;
                }
            }
        }
    }
    !pending.is_empty() || output.len() - start >= maximum || scanned >= maximum * 8
}

fn relative(root: &Path, target: &Path) -> PathBuf {
    let source = root.components().collect::<Vec<_>>();
    let destination = target.components().collect::<Vec<_>>();
    let shared = source
        .iter()
        .zip(&destination)
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 && target.is_absolute() {
        return target.to_path_buf();
    }
    let mut path = PathBuf::new();
    for part in &source[shared..] {
        if matches!(part, Component::Normal(_)) {
            path.push("..");
        }
    }
    for part in &destination[shared..] {
        path.push(part.as_os_str());
    }
    path
}

fn portable(path: &Path) -> String {
    path.to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

fn wordlist_catalog(root: &Path, repository: &Path) -> (Vec<(String, String)>, bool) {
    let mut pending = vec![root.to_path_buf()];
    let mut counts = Vec::<(PathBuf, u64, u64)>::new();
    let mut indexes = HashMap::new();
    let mut visited = 0;
    let mut scanned = 0;
    while !pending.is_empty() && visited < 10_000 && scanned < 80_000 {
        let directory = pending.pop().expect("checked nonempty directory stack");
        let Ok(values) = entries(&directory) else {
            continue;
        };
        for entry in values {
            scanned += 1;
            if scanned >= 80_000 {
                break;
            }
            let full = entry.path();
            if excluded(
                full.strip_prefix(root)
                    .expect("directory entries stay beneath their scan root"),
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(full);
            } else if kind.is_file() {
                if let Ok(state) = fs::metadata(&full) {
                    let category = relative(root, &directory);
                    let index = *indexes.entry(category.clone()).or_insert_with(|| {
                        counts.push((category, 0, 0));
                        counts.len() - 1
                    });
                    counts[index].1 += 1;
                    counts[index].2 += state.len();
                    visited += 1;
                }
                if visited >= 10_000 {
                    break;
                }
            }
        }
    }
    let items = counts.into_iter().map(|(category, files, bytes)| {
        let source = portable(&relative(repository, &root.join(category)));
        let source = if source.is_empty() { ".".to_owned() } else { source };
        (format!("{source} (catalog)"), format!("SecLists category: {source}; {files} files; {bytes} bytes; filenames and sizes only, wordlist content not indexed."))
    }).collect();
    (
        items,
        !pending.is_empty() || visited >= 10_000 || scanned >= 80_000,
    )
}

fn contains_flag(body: &str) -> bool {
    let bytes = body.as_bytes();
    for (brace, _) in body.match_indices('{') {
        for name in [b"flag".as_slice(), b"tsecbench", b"htb"] {
            let Some(start) = brace.checked_sub(name.len()) else {
                continue;
            };
            if !bytes[start..brace].eq_ignore_ascii_case(name)
                || start > 0
                    && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_')
            {
                continue;
            }
            let content = &bytes[brace..];
            if content[1..]
                .iter()
                .position(|value| matches!(value, b'}' | b'\r' | b'\n'))
                .is_some_and(|end| end > 0 && content[end + 1] == b'}')
            {
                return true;
            }
        }
    }
    false
}

fn source_path(file: &Path, repository: &Path, nuclei_root: &Path) -> String {
    if let Ok(relative) = file.strip_prefix(nuclei_root) {
        return format!("@nuclei-templates/{}", portable(relative));
    }
    portable(&relative(repository, file))
}

fn index(
    root: &Path,
    filename: &Path,
    sources: Vec<String>,
    wordlists: Vec<String>,
    nuclei_root: &Path,
) -> Result<()> {
    let mut db = Connection::open(filename)?;
    db.busy_timeout(Duration::ZERO)?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS index_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(id UNINDEXED,path UNINDEXED,body,tokenize='unicode61')")?;
    let updated = db
        .query_row(
            "SELECT value FROM index_state WHERE key='updated' ",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(value) = updated {
        let value = value.trim();
        let timestamp = if value.is_empty() {
            0.0
        } else {
            value.parse::<f64>().unwrap_or(f64::NAN)
        };
        if (milliseconds()? as f64 - timestamp).partial_cmp(&(15.0 * 60_000.0))
            != Some(std::cmp::Ordering::Greater)
        {
            return Ok(());
        }
    }
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for source in &sources {
        if collect(Path::new(source), &mut files, 10_000) {
            warnings.push(format!(
                "Source indexing limit reached; some files were not indexed: {source}"
            ));
        }
    }
    let mut known_order = Vec::new();
    let mut known = HashMap::new();
    {
        let mut query = db.prepare("SELECT id,path FROM docs")?;
        for row in query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (hash, path) = row?;
            if !known.contains_key(&path) {
                known_order.push(path.clone());
            }
            known.insert(path, hash);
        }
    }
    let transaction = db.transaction()?;
    let mut current = Vec::<(String, String, String)>::new();
    let mut positions = HashMap::new();
    let mut put = |path: String, body: String| {
        let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        if let Some(index) = positions.get(&path) {
            current[*index] = (path, hash, body);
        } else {
            positions.insert(path.clone(), current.len());
            current.push((path, hash, body));
        }
    };
    for file in files {
        let bytes = fs::read(&file)?;
        let body = String::from_utf8_lossy(&bytes).into_owned();
        if !contains_flag(&body) {
            put(source_path(&file, root, nuclei_root), body);
        }
    }
    for wordlist in &wordlists {
        let (items, truncated) = wordlist_catalog(Path::new(wordlist), root);
        if truncated {
            warnings.push(format!(
                "SecLists catalog limit reached; some categories were not indexed: {wordlist}"
            ));
        }
        for (path, body) in items {
            put(path, body);
        }
    }
    drop(put);
    {
        let mut remove = transaction.prepare("DELETE FROM docs WHERE path=?")?;
        let mut insert = transaction.prepare("INSERT INTO docs(id,path,body) VALUES (?,?,?)")?;
        for (path, hash, body) in current {
            if known.get(&path) != Some(&hash) {
                if known.contains_key(&path) {
                    remove.execute([&path])?;
                }
                insert.execute(params![hash, path, body])?;
            }
        }
        for path in known_order {
            if !positions.contains_key(&path) {
                remove.execute([path])?;
            }
        }
    }
    transaction.execute("INSERT INTO index_state VALUES ('updated',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [milliseconds()?.to_string()])?;
    transaction.execute("INSERT INTO index_state VALUES ('warnings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&warnings)?])?;
    transaction.commit()?;
    Ok(())
}

#[napi(js_name = "rebuildKnowledgeIndex")]
pub fn rebuild_knowledge_index(
    root: String,
    filename: String,
    sources: Vec<String>,
    wordlists: Vec<String>,
    nuclei_root: String,
) -> napi::Result<()> {
    index(
        Path::new(&root),
        Path::new(&filename),
        sources,
        wordlists,
        Path::new(&nuclei_root),
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn slice_bounds(total: usize, offset: f64, length: f64) -> (usize, usize) {
    let bound = |value: f64| {
        let value = if value.is_nan() { 0.0 } else { value.trunc() };
        if value < 0.0 {
            (total as f64 + value).max(0.0) as usize
        } else {
            value.min(total as f64) as usize
        }
    };
    let start = bound(offset);
    (start, bound(offset + length).max(start))
}

fn windows_display_path(path: &str) -> String {
    if let Some(value) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{value}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    }
}

fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        windows_display_path(&path)
    } else {
        path.into_owned()
    }
}

fn page(
    id: &str,
    path: &str,
    hash: Option<&str>,
    bytes: &[u8],
    total: usize,
    offset: f64,
    length: f64,
) -> Result<String> {
    let mut result = serde_json::json!({"id":id,"path":path});
    if let Some(hash) = hash {
        result["sha256"] = hash.into();
    }
    result["offset"] = serde_json::json!(offset);
    result["totalBytes"] = total.into();
    result["text"] = String::from_utf8_lossy(bytes).into();
    result["nextOffset"] = if offset + length < total as f64 {
        serde_json::json!(offset + length)
    } else {
        serde_json::Value::Null
    };
    Ok(serde_json::to_string(&result)?)
}

fn read_entry(database: &str, id: &str, offset: f64, length: f64) -> Result<Option<String>> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::ZERO)?;
    let artifact = db
        .query_row(
            "SELECT path,sha256 FROM artifacts WHERE id=?",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((source, expected)) = artifact else {
        return Ok(None);
    };
    let root = fs::canonicalize(
        Path::new(database)
            .parent()
            .ok_or("Knowledge database has no directory")?,
    )?;
    let file = fs::canonicalize(root.join(source.trim_start_matches(std::path::MAIN_SEPARATOR)))?;
    if file == root || !file.starts_with(&root) {
        return Err("Knowledge source is outside the offline generation".into());
    }
    let mut input = fs::File::open(&file)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0;
    let page_start = offset.trunc() as usize;
    let page_end = (offset + length).trunc() as usize;
    let tail_capacity = if offset.is_finite() && offset < 0.0 && length > 0.0 {
        (-offset.trunc()) as usize
    } else {
        0
    };
    let mut bytes = Vec::new();
    let mut tail = VecDeque::<u8>::new();
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if offset >= 0.0 && page_end > page_start {
            let start = page_start.saturating_sub(total).min(count);
            let end = page_end.saturating_sub(total).min(count);
            if end > start {
                bytes.extend_from_slice(&buffer[start..end]);
            }
        } else if tail_capacity > 0 {
            if count >= tail_capacity {
                tail.clear();
                tail.extend(&buffer[count - tail_capacity..count]);
            } else {
                let discard = tail
                    .len()
                    .saturating_add(count)
                    .saturating_sub(tail_capacity);
                tail.drain(..discard);
                tail.extend(&buffer[..count]);
            }
        }
        total += count;
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err("Knowledge source changed; explicitly rebuild the offline index".into());
    }
    if offset > total as f64 {
        return Err("Offset is outside the source".into());
    }
    if offset < 0.0 && tail_capacity > 0 {
        let (start, end) = slice_bounds(total, offset, length);
        if end > start {
            let tail_start = total - tail.len();
            bytes.extend(
                tail.make_contiguous()[start - tail_start..end - tail_start]
                    .iter()
                    .copied(),
            );
        }
    }
    Ok(Some(page(
        id,
        &display_path(&file),
        Some(&expected),
        &bytes,
        total,
        offset,
        length,
    )?))
}

#[napi(js_name = "readKnowledgeArtifact")]
pub fn read_knowledge_artifact(
    database: String,
    id: String,
    offset: f64,
    length: f64,
) -> napi::Result<Option<String>> {
    read_entry(&database, &id, offset, length)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_sources_match_the_existing_path_boundary() {
        for value in [
            ".git/config",
            "writeup/a",
            "write-up/a",
            "write_up/a",
            "writexup/a",
            "writerup/a",
            "docs/flag.txt",
            "credential-local/a",
        ] {
            assert!(excluded(Path::new(value)), "{value}");
        }
        for value in [
            "secrets/a",
            "flags/a",
            "docs/flagship.txt",
            "writeroup/a",
            "docs/normal.md",
        ] {
            assert!(!excluded(Path::new(value)), "{value}");
        }
    }

    #[test]
    fn private_flags_require_a_word_boundary_and_complete_single_line_value() {
        for value in ["TSecBench{fixture}", "(hTb{x})", "flag{秘密}", "éflag{x}"] {
            assert!(contains_flag(value), "{value}");
        }
        for value in [
            "myflag{x}",
            "flag{}",
            "flag{unfinished",
            "flag{a\nb}",
            "flag{a\rb}",
        ] {
            assert!(!contains_flag(value), "{value}");
        }
    }

    #[test]
    fn displayed_windows_paths_match_node_realpath_without_extended_prefixes() {
        assert_eq!(
            windows_display_path(r"\\?\C:\data\source.txt"),
            r"C:\data\source.txt"
        );
        assert_eq!(
            windows_display_path(r"\\?\UNC\server\share\source.txt"),
            r"\\server\share\source.txt"
        );
        assert_eq!(
            windows_display_path(r"C:\data\source.txt"),
            r"C:\data\source.txt"
        );
    }
}
