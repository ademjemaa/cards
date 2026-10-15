import json, csv
y=json.load(open('data/yahoo_yearly.json')); w=json.load(open('data/worldbank_yearly.json'))
A=json.load(open('data/yahoo_assets.json'))
names={t:n for c,l in A.items() for t,n in l}
cats={t:c for c,l in A.items() for t,n in l}
names.update({'XYZ':'Block (Square)','GAP':'Gap'}); cats.update({'XYZ':'Stocks','GAP':'Stocks'})
DROP={'PARA','DEC','WB','TKO'}
sig=lambda x: float('%.5g'%x)

def ys(src): return {int(k):v[:4] for k,v in src['y'].items() if int(k)<=2025}

# gold 1950s from datasets monthly
g={}
for r in csv.DictReader(open('data/gold_monthly.csv')):
    yr=int(r['Date'][:4]); 
    if 1950<=yr<1960: g.setdefault(yr,[]).append(float(r['Price']))
def mon(d):
    best=0;bi=bj=0;mn=1e99;mi=0
    for j,v in enumerate(d):
        if j>0 and v/mn>best: best=v/mn;bi=mi;bj=j
        if v<mn: mn=v;mi=j
    return [sig(d[0]),sig(d[-1]),sig(d[bi]),sig(d[bj])] if best else [sig(d[0]),sig(d[-1]),sig(d[0]),sig(d[-1])]
gold50={yr:mon(v) for yr,v in g.items()}
F=json.load(open('data/fred_yearly.json'))
def FR(k,upto=None):
    y0,rows=F[k]; return {y0+i:r for i,r in enumerate(rows) if upto is None or y0+i<=upto}

def merge(*layers):
    out={}
    for L in reversed(layers): out.update(L)   # first layer wins
    return dict(sorted(out.items()))

WB=lambda k: ys(w['WB:'+k])
merged=[ # id, name, cat, layers
 ('gold','Gold','Metals',[ys(y['GC=F']),WB('Gold'),gold50]),
 ('silver','Silver','Metals',[ys(y['SI=F']),WB('Silver')]),
 ('platinum','Platinum','Metals',[ys(y['PL=F']),WB('Platinum')]),
 ('copper','Copper','Metals',[ys(y['HG=F']),WB('Copper'),FR('WPU1022')]),
 ('aluminum','Aluminum','Metals',[ys(y['ALI=F']),WB('Aluminum')]),
 ('wti','Crude Oil (WTI)','Energy',[ys(y['CL=F']),WB('Crude oil, WTI'),WB('Crude oil, average'),FR('WPU0561')]),
 ('brent','Crude Oil (Brent)','Energy',[ys(y['BZ=F']),WB('Crude oil, Brent')]),
 ('natgas','Natural Gas (US)','Energy',[ys(y['NG=F']),WB('Natural gas, US')]),
 ('corn','Corn','Agriculture',[ys(y['ZC=F']),WB('Maize'),FR('WPU0122')]),
 ('wheat','Wheat','Agriculture',[ys(y['ZW=F']),WB('Wheat, US SRW'),FR('WPU0121')]),
 ('soybeans','Soybeans','Agriculture',[ys(y['ZS=F']),WB('Soybeans')]),
 ('soyoil','Soybean Oil','Agriculture',[ys(y['ZL=F']),WB('Soybean oil')]),
 ('soymeal','Soybean Meal','Agriculture',[ys(y['ZM=F']),WB('Soybean meal')]),
 ('coffee','Coffee (Arabica)','Agriculture',[ys(y['KC=F']),WB('Coffee, Arabica')]),
 ('cocoa','Cocoa','Agriculture',[ys(y['CC=F']),WB('Cocoa')]),
 ('sugar','Sugar','Agriculture',[ys(y['SB=F']),WB('Sugar, world')]),
 ('cotton','Cotton','Agriculture',[ys(y['CT=F']),WB('Cotton, A Index')]),
]
used_y={'GC=F','SI=F','PL=F','HG=F','ALI=F','CL=F','BZ=F','NG=F','ZC=F','ZW=F','ZS=F','ZL=F','ZM=F','KC=F','CC=F','SB=F','CT=F'}
used_w={'Gold','Silver','Platinum','Copper','Aluminum','Crude oil, WTI','Crude oil, average','Crude oil, Brent','Natural gas, US','Maize','Wheat, US SRW','Soybeans','Soybean oil','Soybean meal','Coffee, Arabica','Cocoa','Sugar, world','Cotton, A Index','Natural gas index'}
wbcat={'Coal':'Energy','Natural gas':'Energy','Liquefied':'Energy','Crude':'Energy','Aluminum':'Metals','Iron':'Metals','Copper':'Metals','Lead':'Metals','Tin':'Metals','Nickel':'Metals','Zinc':'Metals','Phosphate':'Materials','DAP':'Materials','TSP':'Materials','Urea':'Materials','Potassium':'Materials','Logs':'Materials','Sawnwood':'Materials','Plywood':'Materials','Rubber':'Materials','Tobacco':'Agriculture','Beef':'Food','Chicken':'Food','Lamb':'Food','Shrimps':'Food','Banana':'Food','Orange':'Food','Fish':'Food'}
assets=[]
for i,n,c,L in merged: assets.append({'id':i,'name':n,'cat':c,'y':merge(*L)})
for t,e in y.items():
    if t in used_y or t in DROP: continue
    n=names.get(t,e['meta']['name']).replace(' (futures)','')
    c=cats.get(t,'Stocks')
    if c in('Energy','Agriculture') and t in('LE=F','GF=F','HE=F'): c='Food'
    yy=ys(e)
    if t=='FNMA' and 2014 in yy: a,b,_,_=yy[2014]; yy[2014]=[a,b,min(a,b),max(a,b)]
    if t=='SU': yy.pop(1993,None)
    if t=='ZARUSD=X': yy.pop(2006,None)
    if t=='LE=F': yy=merge(yy,FR('WPU0131'))
    assets.append({'id':t,'name':n,'cat':c,'y':yy})
for k,e in w.items():
    n=k[3:]
    if n in used_w: continue
    c=next((v for p,v in wbcat.items() if n.startswith(p)),'Agriculture')
    yy=ys(e)
    if n=='Chicken': yy=merge(yy,FR('WPU0141'))
    if n=='Coal, Australian': yy=merge(yy,FR('WPU051'))
    assets.append({'id':'wb-'+n.lower().replace(', ','-').replace(' ','-').replace('%','pct').replace('.',''),'name':n,'cat':c,'y':yy})
for k,n,c in [('WPU081','Lumber (US)','Materials'),('WPU101','Steel (US)','Metals'),('WPU0113','Fresh Vegetables (US)','Food'),('WPU091','Paper & Pulp (US)','Materials'),('WPU0223','Seafood (US)','Food')]:
    assets.append({'id':k.lower(),'name':n,'cat':c,'y':FR(k)})
order=['Stocks','ETFs','Indices','Metals','Energy','Agriculture','Food','Materials','Crypto','Currencies']
assets.sort(key=lambda a:(order.index(a['cat']),a['name'].lower()))
# compact: years as offset from first year arrays
out=[]
for a in assets:
    y0=min(a['y']); y1=max(a['y'])
    rows=[a['y'].get(k) or 0 for k in range(y0,y1+1)]
    out.append([a['id'],a['name'],a['cat'],y0,rows])
json.dump(out,open('data/assets.json','w'),separators=(',',':'))
from collections import Counter
print(len(out),Counter(a[2] for a in out)); import os;print(os.path.getsize('data/assets.json'))
for yr in (1950,1960,1975,1990,2005,2020): print(yr,sum(1 for a in out if a[3]<=yr<=a[3]+len(a[4])-1 and a[4][yr-a[3]]))

# Inject the dataset into the page template -> public/index.html
src=open('data/index.src.html').read()
open('public/index.html','w').write(src.replace('/*DATA*/',open('data/assets.json').read()))
print('wrote public/index.html')
