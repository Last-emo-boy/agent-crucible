import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {isAddress} from 'viem';
import {ROOT,tokenSalt,json} from './lib.mjs';

const {values}=parseArgs({options:{creator:{type:'string'},publish:{type:'boolean'}}});
if(!isAddress(values.creator??''))throw new Error('Confirmed --creator address required');
if(!values.publish)throw new Error('No upload performed; --publish is required');
const token=tokenSalt(values.creator);
const meta={
  creator:values.creator,
  website:`https://flap.sh/bnb/${token.address}/taxinfo`,
  twitter:null,telegram:null,
  description:'Agent Crucible (CRUX): all-pay sealed-bid PvP on BNB Chain. All revealed bids go to DEAD; missing reveal loses the locked cap. Highest bids split a fixed BNB prize. Tax: 1% buy / 1% sell, plus protocol fees. Net tax receipts: 10% fixed project treasury, 90% game. Explicit prize sponsorship pays no project fee. Capped, expiring agent authorization. No guaranteed profit. Interface: agent-crucible/1.',
};
const form=new FormData();
form.append('operations',JSON.stringify({query:'mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }',variables:{file:null,meta}}));
form.append('map',JSON.stringify({'0':['variables.file']}));
form.append('0',new File([await readFile(new URL('assets/crux.png',ROOT))],'crux.png',{type:'image/png'}));
const response=await fetch('https://funcs.flap.sh/api/upload',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
const result=await response.json();
if(!response.ok||result.errors||typeof result.data?.create!=='string')throw new Error(`Metadata upload rejected: ${json(result)}`);
const cid=result.data.create;
const check=await fetch(`https://flap.mypinata.cloud/ipfs/${cid}`,{signal:AbortSignal.timeout(30000)});
if(!check.ok)throw new Error(`Pinned metadata could not be read: HTTP ${check.status}`);
const pinned=await check.json();
if(pinned.description!==meta.description||pinned.website!==meta.website||!pinned.image)throw new Error('Pinned metadata differs from submitted metadata');
await mkdir(new URL('artifacts/',ROOT),{recursive:true});
await writeFile(new URL('artifacts/metadata.json',ROOT),json({cid,token:token.address,metadata:pinned}));
console.log(json({cid,token:token.address,metadataVerified:true,image:pinned.image}));
