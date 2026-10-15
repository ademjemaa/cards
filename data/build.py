"""Build the game dataset.

Inputs (all in data/):
  yahoo_yearly.json / worldbank_yearly.json / fred_yearly.json  per-year [entry, exit, optEntry, optExit]
  yahoo_paths.json  / worldbank_paths.json  / fred_paths.json    per-year price path for the reveal chart:
      [lo, hi, "24 chars, each 0-63 = position between lo and hi", "2 chars: lucky buy/sell position in the year"]
  yahoo_assets.json  display names and categories for Yahoo tickers

Outputs:
  data/assets.json    [[id, name, category, firstYear, [[entry, exit, optEntry, optExit] | 0, ...], aliases], ...]
  public/series.json  {id: [firstYear, [[lo, hi, path, luckyPos] | 0, ...]], ...}
  public/index.html   data/index.src.html with assets.json injected at /*DATA*/

Run from the repo root: python3 data/build.py
"""
import json, os
from collections import Counter

MIN_YEAR, MAX_YEAR = 1962, 2025
J = lambda f: json.load(open('data/' + f))
y, w, F = J('yahoo_yearly.json'), J('worldbank_yearly.json'), J('fred_yearly.json')
yP, wP, fP = J('yahoo_paths.json'), J('worldbank_paths.json'), J('fred_paths.json')
A = J('yahoo_assets.json')
names = {t: n for c, l in A.items() for t, n in l}
cats = {t: c for c, l in A.items() for t, n in l}
names.update({'XYZ': 'Block (Square)', 'GAP': 'Gap'}); cats.update({'XYZ': 'Stocks', 'GAP': 'Stocks'})
DROP = {'PARA', 'DEC', 'WB', 'TKO'}

# A layer is {year: (values, path)}; the first layer that has a year wins.
def Y(t):
    p = yP.get(t, {})
    return {int(k): (v[:4], p.get(k)) for k, v in y[t]['y'].items() if MIN_YEAR <= int(k) <= MAX_YEAR}
def WB(name):
    p = wP.get('WB:' + name, {})
    return {int(k): (v[:4], p.get(k)) for k, v in w['WB:' + name]['y'].items() if MIN_YEAR <= int(k) <= MAX_YEAR}
def FR(code, upto=MAX_YEAR):
    y0, rows = F[code]; p = fP.get(code, {})
    return {y0 + i: (r, p.get(str(y0 + i))) for i, r in enumerate(rows) if MIN_YEAR <= y0 + i <= upto}
def merge(*layers):
    out = {}
    for L in reversed(layers): out.update(L)
    return dict(sorted(out.items()))

merged = [
 ('gold', 'Gold', 'Metals', [Y('GC=F'), WB('Gold')]),
 ('silver', 'Silver', 'Metals', [Y('SI=F'), WB('Silver')]),
 ('platinum', 'Platinum', 'Metals', [Y('PL=F'), WB('Platinum')]),
 ('copper', 'Copper', 'Metals', [Y('HG=F'), WB('Copper')]),
 ('aluminum', 'Aluminum', 'Metals', [Y('ALI=F'), WB('Aluminum')]),
 ('wti', 'Crude Oil (WTI)', 'Energy', [Y('CL=F'), WB('Crude oil, WTI'), WB('Crude oil, average')]),
 ('brent', 'Crude Oil (Brent)', 'Energy', [Y('BZ=F'), WB('Crude oil, Brent')]),
 ('natgas', 'Natural Gas (US)', 'Energy', [Y('NG=F'), WB('Natural gas, US')]),
 ('corn', 'Corn', 'Agriculture', [Y('ZC=F'), WB('Maize')]),
 ('wheat', 'Wheat', 'Agriculture', [Y('ZW=F'), WB('Wheat, US SRW')]),
 ('soybeans', 'Soybeans', 'Agriculture', [Y('ZS=F'), WB('Soybeans')]),
 ('soyoil', 'Soybean Oil', 'Agriculture', [Y('ZL=F'), WB('Soybean oil')]),
 ('soymeal', 'Soybean Meal', 'Agriculture', [Y('ZM=F'), WB('Soybean meal')]),
 ('coffee', 'Coffee (Arabica)', 'Agriculture', [Y('KC=F'), WB('Coffee, Arabica')]),
 ('cocoa', 'Cocoa', 'Agriculture', [Y('CC=F'), WB('Cocoa')]),
 ('sugar', 'Sugar', 'Agriculture', [Y('SB=F'), WB('Sugar, world')]),
 ('cotton', 'Cotton', 'Agriculture', [Y('CT=F'), WB('Cotton, A Index')]),
]
used_y = {'GC=F', 'SI=F', 'PL=F', 'HG=F', 'ALI=F', 'CL=F', 'BZ=F', 'NG=F', 'ZC=F', 'ZW=F', 'ZS=F', 'ZL=F', 'ZM=F', 'KC=F', 'CC=F', 'SB=F', 'CT=F'}
used_w = {'Gold', 'Silver', 'Platinum', 'Copper', 'Aluminum', 'Crude oil, WTI', 'Crude oil, average', 'Crude oil, Brent', 'Natural gas, US', 'Maize', 'Wheat, US SRW', 'Soybeans', 'Soybean oil', 'Soybean meal', 'Coffee, Arabica', 'Cocoa', 'Sugar, world', 'Cotton, A Index', 'Natural gas index'}
wbcat = {'Coal': 'Energy', 'Natural gas': 'Energy', 'Liquefied': 'Energy', 'Crude': 'Energy', 'Aluminum': 'Metals', 'Iron': 'Metals', 'Copper': 'Metals', 'Lead': 'Metals', 'Tin': 'Metals', 'Nickel': 'Metals', 'Zinc': 'Metals', 'Phosphate': 'Materials', 'DAP': 'Materials', 'TSP': 'Materials', 'Urea': 'Materials', 'Potassium': 'Materials', 'Logs': 'Materials', 'Sawnwood': 'Materials', 'Plywood': 'Materials', 'Rubber': 'Materials'}
wbname = {'DAP': 'DAP fertilizer', 'TSP': 'TSP fertilizer', 'Urea': 'Urea fertilizer', 'Potassium chloride': 'Potash (potassium chloride)', 'Iron ore, cfr spot': 'Iron ore', 'Tobacco, US import u.v.': 'Tobacco', 'Shrimps, Mexican': 'Shrimp', 'Cotton, A Index': 'Cotton'}

# Extra words players might type for an asset (matched after removing spaces and punctuation).
ALIASES = {
 '^GSPC': 'sp500 s&p spx standard poors', 'SPY': 'sp500 s&p spx index fund', 'VTI': 'total market sp500', '^DJI': 'dow djia dow jones', 'DIA': 'dow djia',
 '^IXIC': 'nasdaq', '^NDX': 'nasdaq100 nasdaq', 'QQQ': 'nasdaq100 nasdaq qqq', '^NYA': 'nyse new york stock exchange', '^RUT': 'small caps', 'IWM': 'small caps russell',
 'GLD': 'gold', 'SLV': 'silver', 'USO': 'oil crude', 'UNG': 'natural gas', 'TLT': 'bonds treasury', 'IEF': 'bonds treasury', 'HYG': 'bonds junk', 'LQD': 'bonds corporate',
 'VNQ': 'reit real estate', 'EFA': 'europe international', 'EEM': 'emerging markets', 'TQQQ': 'leveraged nasdaq', 'SQQQ': 'short nasdaq inverse', 'SH': 'short inverse',
 'BTC-USD': 'btc crypto', 'ETH-USD': 'eth crypto', 'IBIT': 'bitcoin etf', 'GOOGL': 'google', 'META': 'facebook fb', 'BRK-A': 'buffett berkshire', 'XYZ': 'square sq',
 'wti': 'oil petroleum crude', 'brent': 'oil petroleum crude', 'corn': 'maize', 'MSTR': 'microstrategy saylor', '^N225': 'japan', '^FTSE': 'uk london', '^GDAXI': 'germany',
 '^FCHI': 'france paris', 'DX-Y.NYB': 'dollar dxy usd',
}
POPULAR = ['^GSPC', 'SPY', '^DJI', '^IXIC', 'QQQ', '^NYA', 'gold', 'silver', 'wti', 'natgas', 'BTC-USD', 'ETH-USD', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'NVDA', 'TSLA', 'META',
           'NFLX', 'KO', 'MCD', 'DIS', 'IBM', 'XOM', 'GE', 'BRK-A', 'WMT', 'corn', 'wheat', 'coffee', 'copper', 'TLT', 'EURUSD=X', 'GME']

assets = []
for i, n, c, L in merged: assets.append({'id': i, 'name': n, 'cat': c, 'y': merge(*L)})
for t, e in y.items():
    if t in used_y or t in DROP: continue
    n = names.get(t, e['meta']['name']).replace(' (futures)', '')
    c = cats.get(t, 'Stocks')
    if t in ('LE=F', 'GF=F', 'HE=F'): c = 'Agriculture'
    yy = Y(t)
    if t == 'FNMA' and 2014 in yy: (a, b, _, _), p = yy[2014]; yy[2014] = ([a, b, min(a, b), max(a, b)], None)
    if t == 'SU': yy.pop(1993, None)
    if t == 'ZARUSD=X': yy.pop(2006, None)
    if t == 'LE=F': yy = merge(yy, FR('WPU0131'))
    assets.append({'id': t, 'name': n, 'cat': c, 'y': yy})
for k in w:
    n = k[3:]
    if n in used_w: continue
    c = next((v for p, v in wbcat.items() if n.startswith(p)), 'Agriculture')
    yy = WB(n)
    if n == 'Coal, Australian': yy = merge(yy, FR('WPU051'))
    if n == 'Chicken': yy = merge(yy, FR('WPU0141'))
    aid = 'wb-' + n.lower().replace(', ', '-').replace(' ', '-').replace('%', 'pct').replace('.', '')
    assets.append({'id': aid, 'name': wbname.get(n, n), 'cat': c, 'y': yy})
for k, n, c in [('WPU081', 'Lumber (US)', 'Materials'), ('WPU101', 'Steel (US)', 'Metals'), ('WPU0113', 'Fresh Vegetables (US)', 'Agriculture'),
                ('WPU091', 'Paper & Pulp (US)', 'Materials'), ('WPU0223', 'Seafood (US)', 'Agriculture')]:
    assets.append({'id': k.lower(), 'name': n, 'cat': c, 'y': FR(k)})

order = ['Stocks', 'ETFs', 'Indices', 'Metals', 'Energy', 'Agriculture', 'Materials', 'Crypto', 'Currencies']
assets = [a for a in assets if a['y']]
assets.sort(key=lambda a: (order.index(a['cat']), a['name'].lower()))
ids = {a['id'] for a in assets}
assert all(p in ids for p in POPULAR), [p for p in POPULAR if p not in ids]

out, series, missing = [], {}, 0
for a in assets:
    y0, y1 = min(a['y']), max(a['y'])
    rows, paths = [], []
    for k in range(y0, y1 + 1):
        v = a['y'].get(k)
        rows.append(v[0] if v else 0)
        p = v[1] if v else None
        if v and not p: missing += 1
        paths.append(p or 0)
    out.append([a['id'], a['name'], a['cat'], y0, rows, ALIASES.get(a['id'], '')])
    series[a['id']] = [y0, paths]
meta = {'popular': POPULAR}
json.dump({'assets': out, 'meta': meta}, open('data/assets.json', 'w'), separators=(',', ':'))
json.dump(series, open('public/series.json', 'w'), separators=(',', ':'))
print(len(out), 'assets', dict(Counter(a[2] for a in out)))
print('assets.json', os.path.getsize('data/assets.json'), 'bytes; series.json', os.path.getsize('public/series.json'), 'bytes; years without a path:', missing)

src = open('data/index.src.html').read()
open('public/index.html', 'w').write(src.replace('/*DATA*/', open('data/assets.json').read()))
print('wrote public/index.html')
