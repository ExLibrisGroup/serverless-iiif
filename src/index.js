
const AWS = require('aws-sdk');
const IIIF = require('iiif-processor');
const middy = require('middy');
const md5 = require('md5');
const Utils = require('./utils.js');
const { cors, httpHeaderNormalizer } = require('middy/middlewares');

const handleRequest = (event, context, callback) => {
  try {
    new IIIFLambda(event, context, callback)
      .processRequest();
  } catch (err) {
    callback(err, null);
  }
};

class IIIFLambda {
  constructor (event, context, callback) {
    this.event = event;
    this.context = context;
    this.respond = callback;
    this.sourceBucket = this.getBucketFromIdentifier();
    this.initResource();
  }

  directResponse (result) {    
    var base64 = /^image\//.test(result.contentType);
    var content = base64 ? result.body.toString('base64') : result.body;
    if (content.length > 5*1024*1024) {
      this.cacheResult(result, (cacheUrl) => 
        this.respond(null, { statusCode: 303, headers: { Location: cacheUrl } }));
    } else {
      var response = {
        statusCode: 200,
        headers: { 'Content-Type': result.contentType },
        isBase64Encoded: base64,
        body: content
      };
      this.respond(null, response);
      this.cacheResult(result);
    }
  }

  handleError (err, resource) {
    if (err.statusCode) {
      this.respond(null, {
        statusCode: err.statusCode,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Not Found'
      });
    } else if (err instanceof this.resource.errorClass) {
      this.respond(null, {
        statusCode: 400,
        headers: { 'Content-Type': 'text/plain' },
        body: err.toString()
      });
    } else {
      this.respond(err, null);
    }
  }

  initResource () {
    var scheme = this.event.headers['X-Forwarded-Proto'] || 'http';
    var host = this.event.headers['Host'];
    var path = this.path();
    var uri = `${scheme}://${host}${path}`;

    this.resource = new IIIF.Processor(uri, id => this.s3Object(id));
  }

  async processRequest () {
    AWS.config.region = this.context.invokedFunctionArn.match(/^arn:aws:lambda:(\w+-\w+-\d+):/)[1];
    const cacheUrl = await this.checkCache();
    if (this.event.httpMethod === 'OPTIONS') {
      this.respond(null, { statusCode: 204, body: null });
    } else if (cacheUrl) {
      this.respond(null, { statusCode: 303, headers: { Location: cacheUrl } });
    } else {
      this.resource.execute()
        .then(result => this.directResponse(result))
        .catch(err => this.handleError(err))
        .finally(() => Utils.clearDir(require('os').tmpdir()));
    }
  }

  cacheResult ( result, callback = () => null ) {
    const s3 = new AWS.S3();
    const params = {
      Bucket: this.sourceBucket,
      Key: this.cacheKey(),
      ContentType: result.contentType,
      Body: result.body
    };
    s3.upload( params, ( err, data ) => 
      callback(s3.getSignedUrl('getObject', { Bucket: params.Bucket, Key: params.Key } )))
  }

  getBucketFromIdentifier(){    
    var bucket= process.env.tiffBucket;
    try {
      var id=this.event.path.substring(8);
      id= id.substring(0, id.indexOf('/'));
      var decode= Buffer.from(decodeURIComponent(id), 'base64').toString('utf8');
      var identifier = JSON.parse(decode);
      bucket= identifier.bucket;
    } catch(err) {
      console.error(err);
    }
    
    console.log('bucket: ' + bucket);
    return bucket;
  }
  
  getKeyFromIdentifier(id){
    var key= id;
    try {
      var decode= Buffer.from(decodeURIComponent(id), 'base64').toString('utf8');
      var identifier = JSON.parse(decode);
      key= identifier.key;
    } catch(err) {
      console.error(err);
    }
    return key;
  }

  path() {
    var path = this.event.path;
    if (!/\.(jpg|tif|gif|png|json)$/.test(path)) {
      path = path + '/info.json';
    }
    if (process.env.include_stage) {
      path = '/' + this.event.requestContext.stage + path;
    }
    return path;
  }

  cacheKey () {
    let path = this.path();
    return `iiif-cache/${md5(path).match(/.{1,2}/g).join('/')}${path.substring(path.lastIndexOf('/'))}`;
  }  

  async checkCache () {
    const s3 = new AWS.S3();
    var cacheKey= this.cacheKey();
    if (cacheKey.endsWith('info.json')){
      return false;
    }

    const params = { Bucket: this.sourceBucket, Key: cacheKey };
    try {
      await s3.headObject(params).promise();
      return s3.getSignedUrl('getObject', params);
    } catch(e) {
      return false;
    }
  }

  s3Object (id) {
    var id= this.getKeyFromIdentifier(id);
    var s3 = new AWS.S3();
    return s3.getObject({
      Bucket: this.sourceBucket,
      Key: id + (/\.(\w*)$/.test(id) ? '' : '.tif')
    }).createReadStream();
  }
}

module.exports = {
  handler: middy(handleRequest)
    .use(httpHeaderNormalizer())
    .use(cors())
};
