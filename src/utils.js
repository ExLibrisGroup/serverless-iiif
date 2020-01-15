const fs = require('fs');

module.exports = 
{
  clearDir: (directory) => {
    fs.readdir(directory, { withFileTypes: true }, (err, files) => {
      if (err) throw err;
      for (const file of files) {
        const fullpath = path.join(directory, file.name)
        if (file.isDirectory()) {
          fs.rmdir(fullpath, { recursive: true }, err => { if (err) throw err;});
        } else {
          fs.unlink(fullpath, err => { if (err) throw err; });
        }
      }
    });
  }
}
