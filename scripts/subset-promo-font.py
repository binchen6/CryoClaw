"""Build the offline MiSans subset used by the latest website demo film."""
from pathlib import Path
import argparse
from fontTools import subset
from fontTools.ttLib import TTFont

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font-library',type=Path,required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
project=Path(__file__).resolve().parent.parent/'website/promo/latest'
text=''.join((project/name).read_text(encoding='utf-8') for name in ['index.html','promo.js','film.json'])
characters=set(map(ord,text))|set(range(32,127))
output=project/'fonts/DemoMiSans.woff2'
if args.check:
    font=TTFont(output)
    missing={code for code in characters if 0x2e80<=code<=0x9fff}-set(font.getBestCmap())
    if missing:
        raise SystemExit('Missing film characters: '+''.join(map(chr,sorted(missing))))
    print(f'Film font coverage verified: {output.stat().st_size:,} bytes')
else:
    options=subset.Options()
    options.flavor='woff2'
    options.layout_features=['*']
    options.name_IDs=['*']
    font=subset.load_font(str(args.font_library/'chinese/MiSans/MiSans-VF.ttf'),options)
    subsetter=subset.Subsetter(options=options)
    subsetter.populate(unicodes=characters)
    subsetter.subset(font)
    output.parent.mkdir(parents=True,exist_ok=True)
    subset.save_font(font,str(output),options)
    print(f'DemoMiSans: {output.stat().st_size:,} bytes')
