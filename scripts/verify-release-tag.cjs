const version=require('../package.json').version;if(process.env.GITHUB_REF_NAME!=='v'+version)throw Error('Git tag 必须与 package.json.version 一致：v'+version);
