"""Export web fonts from the user's font library. Requires fonttools[woff]."""
from pathlib import Path
import argparse
from fontTools import subset

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font-library', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
website = root / 'website'
text = ''.join((website / name).read_text(encoding='utf-8') for name in ['index.html', 'app.js', 'styles.css'])
latin = set(range(0x100)) | set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200))
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
