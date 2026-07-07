const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'templates');
const destDir = path.join(__dirname, '..', 'dist', 'templates');

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (!fs.existsSync(srcDir)) {
  console.error('Templates source directory not found:', srcDir);
  process.exit(1);
}

copyDir(srcDir, destDir);
console.log('Templates copied to', destDir);