const fs = require('fs');
const path = require('path');

function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.tmp-awdump' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walk(fullPath));
    } else if (entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = walk('.');
let count = 0;
const search = '"firebase/firestore": "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"';
const replace = '"firebase/firestore": "/js/appwrite-db.js"';

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes(search)) {
    const newContent = content.split(search).join(replace);
    fs.writeFileSync(file, newContent, 'utf8');
    console.log('Reverted:', file);
    count++;
  }
}
console.log('Total files reverted:', count);