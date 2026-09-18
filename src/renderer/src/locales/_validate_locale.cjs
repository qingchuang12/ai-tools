// Validation: ensure a locale file mirrors en.json structure and preserves all placeholder tokens.
const fs = require('fs');
const dir = __dirname;
const en = JSON.parse(fs.readFileSync(dir + '/en.json', 'utf8'));

function leaves(o, p = '') {
    const r = [];
    for (const k of Object.keys(o)) {
        const np = p ? p + '.' + k : k;
        if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) r.push(...leaves(o[k], np));
        else r.push({ p: np, v: o[k] });
    }
    return r;
}
const enLeaves = leaves(en);
const enMap = new Map(enLeaves.map((x) => [x.p, x.v]));

// placeholder tokens: {{name}} or {dir}
function ph(v) {
    return (String(v).match(/\{\{?\w+\}\}?/g) || []).sort();
}

const langs = process.argv.slice(2);
for (const L of langs) {
    const j = JSON.parse(fs.readFileSync(dir + '/' + L + '.json', 'utf8'));
    const tl = leaves(j);
    const tMap = new Map(tl.map((x) => [x.p, x.v]));
    let missing = 0, same = 0, phMiss = 0;
    const phMissList = [];
    for (const { p, v } of enLeaves) {
        if (!tMap.has(p)) { missing++; continue; }
        const tv = tMap.get(p);
        if (JSON.stringify(ph(v)) !== JSON.stringify(ph(tv))) { phMiss++; if (phMissList.length < 10) phMissList.push(p); }
        if (tv === v) same++;
    }
    console.log(`${L.padEnd(8)} leaves=${tl.length} missingKeys=${missing} sameAsEn=${same} placeholderMismatch=${phMiss}`);
    if (phMissList.length) console.log('   phMiss keys:', phMissList.join(', '));
}
