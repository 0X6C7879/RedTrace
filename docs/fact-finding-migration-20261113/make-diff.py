import difflib,json,pathlib,tarfile
root=pathlib.Path("/Users/lxy/Downloads/RedTrace")
out=pathlib.Path("/Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113")
changes=json.loads((out/"CHANGED_FILES.json").read_text())
patch=[]
with tarfile.open(out/"BASELINE.tar.gz") as archive:
 for p in sorted(changes["modified"]+changes["added"]):
  old=archive.extractfile(p).read().decode("utf-8") if p in changes["modified"] else ""
  new=(root/p).read_text()
  for line in difflib.unified_diff(old.splitlines(keepends=True),new.splitlines(keepends=True),fromfile=("a/"+p if p in changes["modified"] else "/dev/null"),tofile="b/"+p):
   patch.append(line if line.endswith("\n") else line+"\n\\ No newline at end of file\n")
(out/"DIFF_FILE.patch").write_text("".join(patch))
