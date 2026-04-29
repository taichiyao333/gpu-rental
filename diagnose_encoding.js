const fs = require('fs');
const iconv = require('iconv-lite');

// The issue: When a Shift-JIS file is read as UTF-8, the bytes get
// incorrectly interpreted. We need to:
// 1. Read the file as UTF-8 (how it's currently stored)
// 2. Re-encode the garbled text back to bytes as if it's Windows-1252/Latin-1
// 3. Then decode those bytes as Shift-JIS

const utf8Content = fs.readFileSync('public/portal/index.html', 'utf8');

// Check the garbled pattern more precisely
// 繝 = U+7E5D which in UTF-8 is E7 B9 9D
// This is a common pattern for Shift-JIS bytes treated as UTF-8
// "繝ｻ" = the Katakana middle dot "･" in Shift-JIS

// The actual characters in the file ARE proper Mojibake pattern
// We need to take each character, get its UTF-8 encoding, 
// interpret those bytes as a different encoding

// Method: re-encode UTF-8 back to raw bytes, then decode as Shift-JIS
const rawBytes = Buffer.from(utf8Content, 'utf8');
console.log('File size as raw UTF-8 bytes:', rawBytes.length);

// Try: treat the raw bytes as Shift-JIS
const asSJIS = iconv.decode(rawBytes, 'Shift_JIS');
const hasPropJP1 = /すべて|空きあり/.test(asSJIS);
console.log('As SJIS: has proper JP:', hasPropJP1);

// Try: binary/latin1 round-trip
// Take each UTF-8 character, get its char code as a byte, decode as SJIS
// This works when file was saved as SJIS but opened/resaved treating bytes as Unicode codepoints

// Method 2: Use latin1 to get the raw byte values
const asLatin1Bytes = Buffer.from(utf8Content, 'latin1');
const fromLatin1 = iconv.decode(asLatin1Bytes, 'Shift_JIS');
const hasPropJP2 = /すべて|空きあり/.test(fromLatin1);
console.log('Latin1 round-trip -> SJIS: has proper JP:', hasPropJP2);
if (hasPropJP2) {
    console.log('Sample:', fromLatin1.slice(0, 300));
}

// Method 3: The BOM is EF BB BF (UTF-8 BOM), and after that...
// Read as binary buffer, skip BOM, decode rest as SJIS
const buf = fs.readFileSync('public/portal/index.html');
console.log('\nFirst 10 bytes:', buf.slice(0, 10).toString('hex'));
const noBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? buf.slice(3) : buf;
const fromRaw = iconv.decode(noBom, 'Shift_JIS');
const hasPropJP3 = /すべて|空きあり/.test(fromRaw);
console.log('Raw buf -> SJIS (no BOM attempt): has proper JP:', hasPropJP3);
if (hasPropJP3) {
    const filterMatch = fromRaw.match(/filter-btn[^>]*>([^<]+)</g);
    console.log('Filter buttons:', filterMatch ? filterMatch.slice(0,3) : 'not found');
}
