'use strict';
const fs = require('fs');

// Keep legacy unquoted/single-quoted entries readable. Newly saved values use
// JSON string quoting so whitespace, quotes and backslashes survive a restart.
function parse(text) {
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || values.has(m[1])) continue;
        let value = m[2];
        if (value.startsWith('"') && value.endsWith('"')) {
            try { value = JSON.parse(value); }
            catch { value = value.slice(1, -1); }
        } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        values.set(m[1], value);
    }
    return values;
}

function save(file, key, value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment key');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const entry = `${key}=${JSON.stringify(String(value))}`;
    // Replace the first occurrence and remove duplicates: otherwise an older
    // credential can unexpectedly win on restart or in another env reader.
    let found = false;
    const lines = text.split(/\r?\n/).filter(line => {
        if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return true;
        if (found) return false;
        found = true;
        return true;
    }).map(line => new RegExp(`^\\s*${key}\\s*=`).test(line) ? entry : line);
    if (!found) lines.push(entry);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch { /* Android shared filesystems */ }
        fs.renameSync(tmp, file);
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed or not created */ }
    }
}
module.exports = { parse, save };
