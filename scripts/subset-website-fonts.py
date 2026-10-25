"""Export web fonts from the user's font library. Requires fonttools[woff]."""
from pathlib import Path
import argparse
from fontTools import subset
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font-library', type=Path, required=True)
parser.add_argument('--check', action='store_true', help='Verify current WOFF2 coverage without rewriting fonts')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
website = root / 'website'
text = ''.join((website / name).read_text(encoding='utf-8') for name in ['index.html', 'app.js', 'styles.css'])
latin = set(range(0x100)) | set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200))
required_cjk = {ord(char) for char in text if 0x2E80 <= ord(char) <= 0x9FFF or 0xFF00 <= ord(char) <= 0xFFEF}
if args.check:
    total = 0
    for name in ['CryoMiSans', 'CryoInter', 'CryoMono']:
        output = website / 'assets' / 'fonts' / (name + '.woff2')
        font = TTFont(output)
        if font.flavor != 'woff2':
            raise SystemExit(f'{name}: expected WOFF2')
        if name == 'CryoMiSans':
            missing = required_cjk - set(font.getBestCmap())
            if missing:
                raise SystemExit('Missing website characters: ' + ''.join(chr(code) for code in sorted(missing)))
            print(f'CryoMiSans: {len(required_cjk)} CJK characters covered')
        total += output.stat().st_size
        font.close()
    print(f'All three WOFF2 files valid: {total:,} bytes total')
    raise SystemExit(0)
for source, name, characters in [
    ('chinese/MiSans/MiSans-VF.ttf', 'CryoMiSans', set(map(ord, text))),
    ('latin/Inter/InterVariable.ttf', 'CryoInter', latin),
    ('mono/JetBrainsMono/JetBrainsMono[wght].ttf', 'CryoMono', latin),
]:
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = ['*']
    font = subset.load_font(str(args.font_library / source), options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=characters)
    subsetter.subset(font)
    output = website / 'assets' / 'fonts' / (name + '.woff2')
    subset.save_font(font, str(output), options)
    print(f'{name}: {output.stat().st_size:,} bytes')
