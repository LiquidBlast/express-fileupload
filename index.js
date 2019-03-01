const Busboy                                       = require('busboy');
const { dirname }                                  = require('path');
const { PassThrough }                              = require('stream');
const { existsSync, mkdirSync, createWriteStream } = require('fs');

const ACCEPTABLE_MIME = /^(?:multipart\/.+)$/i;
const UNACCEPTABLE_METHODS = [ 'GET', 'HEAD' ];

module.exports = (options) => {
  options = options || {};
  return (req, res, next) => {
    if (!hasBody(req) || !hasAcceptableMethod(req) || !hasAcceptableMime(req)) return next();
    processMultipart(options, req, res, next);
  };
};

const processMultipart = (options, req, res, next) => {
  let busboyOptions = {};
  let busboy;
  req.files = null;
  // Build busboy config
  for (let k in options) { if (Object.prototype.hasOwnProperty.call(options, k)) busboyOptions[k] = options[k]; }
  // Attach request headers to busboy config
  busboyOptions.headers = req.headers;
  // Init busboy instance
  busboy = new Busboy(busboyOptions);
  // Build multipart req.body fields
  busboy.on('field', (fieldname, val) => {
    req.body = req.body || {};
    let prev = req.body[fieldname];
    if (!prev) return req.body[fieldname] = val;
    if (Array.isArray(prev)) return prev.push(val);
    req.body[fieldname] = [prev, val];
  });
  // Build req.files fields
  busboy.on('file', (fieldname, file, filename, encoding, mime) => {
    const buffers = [];
    let safeFileNameRegex = /[^\w-]/g;
    file.on('limit', () => {
      if (options.abortOnLimit) {
        res.writeHead(413, {'Connection': 'close'});
        res.end('File size limit has been reached');
      }
    });
    file.on('data', (data) => {
      buffers.push(data);
      if (options.debug) return console.log('Uploading %s -> %s', fieldname, filename);
    });
    file.on('end', () => {
      if (!req.files) req.files = {};
      const buf = Buffer.concat(buffers);
      // see: https://github.com/richardgirges/express-fileupload/issues/14
      // firefox uploads empty file in case of cache miss when f5ing page.
      // resulting in unexpected behavior. if there is no file data, the file is invalid.
      if (!buf.length) return;
      if (options.safeFileNames) {
        let maxExtensionLength = 3;
        let extension = '';
        if (typeof options.safeFileNames === 'object') safeFileNameRegex = options.safeFileNames;
        maxExtensionLength = parseInt(options.preserveExtension);
        if (options.preserveExtension || maxExtensionLength === 0) {
          if (isNaN(maxExtensionLength)) maxExtensionLength = 3;
          else maxExtensionLength = Math.abs(maxExtensionLength);
          let filenameParts = filename.split('.');
          let filenamePartsLen = filenameParts.length;
          if (filenamePartsLen > 1) {
            extension = filenameParts.pop();
            if (extension.length > maxExtensionLength && maxExtensionLength > 0) {
              filenameParts[filenameParts.length - 1] +=
                '.' + extension.substr(0, extension.length - maxExtensionLength);
              extension = extension.substr(-maxExtensionLength);
            }
            extension = maxExtensionLength ? '.' + extension.replace(safeFileNameRegex, '') : '';
            filename = filenameParts.join('.');
          }
        }
        filename = filename.replace(safeFileNameRegex, '').concat(extension);
      }

      let newFile = {
        name: filename,
        data: buf,
        encoding: encoding,
        truncated: file.truncated,
        mimetype: mime,
        mv: (filePath, callback) => {
          // Callback is passed in, use the callback API
          if (callback) doMove(() => { callback(null); }, (error) => { callback(error); } );
          // Otherwise, return a promise
          else return new Promise((resolve, reject) => { doMove(resolve, reject); });
          function doMove (successFunc, errorFunc) {
            if (options.createParentPath) if (!existsSync( dirname(filePath))) mkdirSync(dirname(filePath));
            const fstream = createWriteStream(filePath);
            let bufferStream = new PassThrough();
            bufferStream.end(new Buffer.from(buf));
            bufferStream.pipe(fstream);
            fstream.on('error', (err) => { errorFunc(err); });
            fstream.on('close', () => { successFunc(); });
          }
        }
      };
      // Non-array fields
      if (!req.files.hasOwnProperty(fieldname)) req.files[fieldname] = newFile;
      else {
        // Array fields
        if (req.files[fieldname] instanceof Array) req.files[fieldname].push(newFile);
        else req.files[fieldname] = [req.files[fieldname], newFile];
      }
    });
    file.on('error', next);
  });
  busboy.on('finish', next);
  busboy.on('error', next);
  req.pipe(busboy);
}

const hasAcceptableMethod = (req) => { return (UNACCEPTABLE_METHODS.indexOf(req.method) < 0); }
const hasAcceptableMime = (req) => {
  let str = (req.headers['content-type'] || '').split(';')[0];
  return ACCEPTABLE_MIME.test(str);
}
const hasBody = (req) => { return ('transfer-encoding' in req.headers) || ('content-length' in req.headers && req.headers['content-length'] !== '0'); }