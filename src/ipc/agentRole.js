// Non-ASCII mappings from Unicode 16.0 UTS #39 whose ASCII targets occur in a reserved
// name. Compatibility equivalents and decimal digits are handled by normalization
// and the ID pattern, respectively.
// https://www.unicode.org/Public/security/16.0.0/confusables.txt
/*!
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
*/
const confusableGroups = {
  a: '⍺ɑα𝛂𝛼𝜶𝝰𝞪аΑ𝚨𝛢𝜜𝝖𝞐АᎪᗅꓮ𖽀𐊠',
  au: 'ꜷꜶ',
  av: 'ꜹꜻꜸꜺ',
  c: 'ᴄϲⲥсꮯ𐐽🝌𑣲ϹⲤСᏟꓚ𐊢𐌂𐐕𐔜',
  d: 'ԁᏧᑯꓒᎠᗞᗪꓓ',
  e: '℮ꬲеҽ⋿Ε𝚬𝛦𝜠𝝚𝞔ЕⴹᎬꓰ𑢦𑢮𐊆',
  g: 'ɡᶃƍցԌᏀᏳꓖ',
  h: 'һհᏂΗ𝚮𝛨𝜢𝝜𝞖ⲎНᎻᕼꓧ𐋏',
  i: '˛⍳ı𝚤ɪɩιιͺ𝛊𝜄𝜾𝝸𝞲іꙇӏꭵᎥ𑣃',
  l: '׀∣⏽￨𐌠𞣇ＩⅠℐℑ𜳞𝐈𝐼𝑰𝓘𝕀𝕴𝖨𝗜𝘐𝙄𝙸ƖǀΙ𝚰𝛪𝜤𝝞𝞘ⲒІӀוןا𞸀𞺀ﺎﺍߊⵏᛁꓲ𖼨𐊊𐌉𝈪ⳐᏞᒪꓡ𖼖𑢣𑢲𐐛𐔦',
  ll: '‖∥Ⅱǁװ',
  n: 'ոռΝ𝚴𝛮𝜨𝝢𝞜Ⲛꓠ𐔓',
  o: 'ంಂംංᴏᴑꬽο𝛐𝜊𝝄𝝾𝞸σ𝛔𝜎𝝈𝞂𝞼ⲟоჿօסه𞸤𞹤𞺄ﻫﻬﻪﻩھﮬﮭﮫﮪہﮨﮩﮧﮦەഠဝ𐓪𑣈𑣗𐐬〇Ο𝚶𝛰𝜪𝝤𝞞ⲞОՕⵔዐଠ𐓂ꓳ𑢵𐊒𐊫𐐄𐔖',
  r: 'ꭇꭈᴦⲅгꮁ𝈖ƦᎡᏒ𐒴ᖇꓣ𖼵',
  s: 'ꜱƽѕꮪ𑣁𐑈ЅՏᏕᏚꓢ𖼺𐊖𐐠',
  t: '⊤⟙🝨Τ𝚻𝛵𝜯𝝩𝞣ⲦТᎢꓔ𖼊𑢼𐊗𐊱𐌕',
  u: 'ꞟᴜꭎꭒʋυ𝛖𝜐𝝊𝞄𝞾ս𐓶𑣘∪⋃Սሀ𐓎ᑌꓴ𖽂𑢸',
  v: '∨⋁ᴠν𝛎𝜈𝝂𝝼𝞶ѵט𑜆ꮩ𑣀𝈍ѴⴸᏙᐯꛟꓦ𖼈𑢠𐔝',
  x: '᙮×⤫⤬⨯хᕁᕽ᙭╳𐌢𑣬ꞳΧ𝚾𝛸𝜲𝝬𝞦ⲬХⵝᚷꓫ𐊐𐊴𐌗𐔧',
  y: 'ɣᶌʏỿꭚγℽ𝛄𝛾𝜸𝝲𝞬уүყ𑣜Υϒ𝚼𝛶𝜰𝝪𝞤ⲨУҮᎩᎽꓬ𖽃𑢤𐊲',
  z: 'ᴢꮓ𑣄𐋵Ζ𝚭𝛧𝜡𝝛𝞕Ꮓꓜ𑢩'
}
const confusables = new Map()
for (const [ascii, group] of Object.entries(confusableGroups)) {
  for (const character of group) confusables.set(character, ascii)
}

const ROLE_SEPARATORS = /[_\p{Dash}\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu
const RESERVED_NAMES = /^(?:나|사용자)|^(?:user|ezshell)$/
const AGENT_ID = /^(?:claude|codex|antigravity)\p{Nd}+$/u
// The same vertical-stroke lookalike can resemble lowercase L or uppercase I.
const CONFUSABLE_AGENT_ID = /^(?:c[il]aude|codex|ant[il]grav[il]ty)\p{Nd}+$/u

function foldRole(role) {
  return role.normalize('NFKC').replace(ROLE_SEPARATORS, '').normalize('NFKC').toLowerCase()
}

function isReservedAgentRole(role) {
  const folded = foldRole(role)
  if (RESERVED_NAMES.test(folded) || AGENT_ID.test(folded)) return true
  if (!/[^\x00-\x7f]/u.test(role)) return false

  // Look up the original glyph before NFKC changes compatibility characters.
  const lookalike = foldRole(role.replace(/[^\x00-\x7f]/gu, character => confusables.get(character) ?? character))
  return lookalike !== folded && (RESERVED_NAMES.test(lookalike) || CONFUSABLE_AGENT_ID.test(lookalike))
}

module.exports = { isReservedAgentRole }
