"""共通ヘッダー・本文・フッターを結合して静的HTMLを生成する。"""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / 'templates'


def build():
    page = (TEMPLATES / 'layout.html').read_text(encoding='utf-8')
    for name in ('header', 'main', 'footer'):
        part = (TEMPLATES / f'{name}.html').read_text(encoding='utf-8').rstrip('\n')
        page = page.replace('{{' + name + '}}', part)
    if re.search(r'\{\{\w+\}\}', page):
        raise ValueError('Unresolved template')
    (ROOT / 'index.html').write_text(page, encoding='utf-8')
    # Local workspace has a separate checkout; GitHub checkout builds in place.
    output = ROOT / 'publish'
    if output.is_dir():
        for name in ('index.html', 'style.css', 'preview.html', 'build.py'):
            shutil.copy2(ROOT / name, output / name)
        for asset in set(re.findall(r'assets/[^"\s<>]+', page)):
            target = output / asset
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / asset, target)
        shutil.copytree(TEMPLATES, output / 'templates', dirs_exist_ok=True)
    print('Built index.html from header / main / footer templates')


if __name__ == '__main__':
    build()
