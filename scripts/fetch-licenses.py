"""Fetch license files only; never extract or execute upstream package code."""
import io, json, pathlib, tarfile, urllib.request
root = pathlib.Path('third_party')
root.mkdir(exist_ok=True)
versions = {'c':'0.20.7', 'c-sharp':'0.20.0', 'cpp':'0.20.4', 'go':'0.20.0', 'java':'0.20.2', 'javascript':'0.20.3', 'python':'0.21.0', 'ruby':'0.20.1', 'rust':'0.20.4', 'typescript':'0.20.5'}
for language, version in versions.items():
    name = 'tree-sitter-' + language
    metadata = json.load(urllib.request.urlopen(f'https://registry.npmjs.org/{name}/{version}'))
    data = urllib.request.urlopen(metadata['dist']['tarball']).read()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        licenses = [m for m in archive.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name.lower() in ('license','license.md','license.txt','copying')]
        if not licenses: raise ValueError(f'No license: {name}')
        content = f'{name}@{version}\nSource: {metadata["dist"]["tarball"]}\n\n'
        content += '\n'.join(archive.extractfile(m).read().decode() for m in licenses)
        (root / f'{name}.txt').write_text(content)
    print(name)
for name in ('web-tree-sitter','tree-sitter-wasms'):
    folder=pathlib.Path('node_modules')/name
    files=[p for p in folder.iterdir() if p.name.lower().startswith('license') and p.is_file()]
    if files: (root / f'{name}.txt').write_text('\n'.join(p.read_text() for p in files))
    elif name=='tree-sitter-wasms':
        (root / f'{name}.txt').write_bytes(urllib.request.urlopen('https://raw.githubusercontent.com/Gregoor/tree-sitter-wasms/main/LICENSE').read())
