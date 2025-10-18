const IndexFactory = require('@tryghost/algolia-indexer');

// ---- helpers --------------------------------------------------
const MAX_CHUNK_BYTES = 6000;   // text per record (~6 KB)
const JSON_SOFT_LIMIT  = 9500;  // keep full JSON < 10 KB

function bLen(str){return Buffer.byteLength(String(str||''),'utf8');}
function clampByBytes(str,limit){
  if(!str)return str; str=String(str);
  if(bLen(str)<=limit)return str;
  let lo=0,hi=str.length,ans='';
  while(lo<=hi){
    const mid=Math.floor((lo+hi)/2),slice=str.slice(0,mid);
    if(bLen(slice)<=limit){ans=slice;lo=mid+1;}else hi=mid-1;
  }
  return ans;
}
function chunkByBytes(str,bytesLimit=MAX_CHUNK_BYTES){
  const out=[]; let start=0; str=String(str||'');
  while(start<str.length){
    let lo=start,hi=str.length,best=start;
    while(lo<=hi){
      const mid=Math.min(start+Math.floor((lo+hi)/2),str.length);
      const slice=str.slice(start,mid);
      if(bLen(slice)<=bytesLimit){best=mid;lo=mid+1;}else hi=mid-1;
    }
    if(best===start)break;
    out.push(str.slice(start,best)); start=best;
  }
  return out;
}
// ---------------------------------------------------------------

exports.handler = async (event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405,body:'Method Not Allowed'};
  const {key}=event.queryStringParameters||{};
  if(key&&key!==process.env.NETLIFY_KEY)return{statusCode:401,body:'Unauthorized'};
  if(process.env.ALGOLIA_ACTIVE!=='TRUE')return{statusCode:200,body:'Algolia inactive'};

  console.log('🚀 Starting Algolia indexing (manual chunk mode)…');

  const algoliaSettings={
    appId:process.env.ALGOLIA_APP_ID,
    apiKey:process.env.ALGOLIA_ADMIN_API_KEY,
    index:process.env.ALGOLIA_INDEX_NAME
  };

  try{
    let {post}=JSON.parse(event.body||'{}');
    post=(post&&post.current&&Object.keys(post.current).length>0&&post.current)||{};
    if(!post.id)return{statusCode:200,body:'No valid post data'};

    const text=String(post.plaintext||post.html||post.custom_excerpt||post.title||'').trim();
    if(!text)return{statusCode:200,body:`No content to index for ${post.title}`};

    // --- split full plaintext into safe chunks -----------------
    const safeSource=clampByBytes(text,600000); // hard upper bound
    const chunks=chunkByBytes(safeSource,MAX_CHUNK_BYTES);
    console.log(`Generated ${chunks.length} chunks (${bLen(text)} bytes total).`);

    if(!chunks.length)return{statusCode:200,body:`No chunks for ${post.title}`};

    // --- build records -----------------------------------------
    const base={
      postId:post.id,
      title:post.title||'',
      slug:post.slug||'',
      url:post.url||'',
      published_at:post.published_at||null,
      primary_tag:post.primary_tag?.name||null,
      tags:(post.tags||[]).map(t=>t.name||t.slug||t).slice(0,10),
      authors:(post.authors||[]).map(a=>a.name||a.slug||a).slice(0,5)
    };

    const records=chunks.map((txt,i)=>{
      let rec={...base,objectID:`${post.id}_${i}`,chunkIndex:i,plaintext:txt};
      if(bLen(JSON.stringify(rec))>JSON_SOFT_LIMIT)
        rec.plaintext=clampByBytes(rec.plaintext,MAX_CHUNK_BYTES-1000);
      return rec;
    });

    const index=new IndexFactory(algoliaSettings);
    await index.setSettingsForIndex({
      searchableAttributes:['title','plaintext'],
      customRanking:['desc(published_at)'],
      distinct:true,
      attributeForDistinct:'postId'
    });
    await index.save(records);

    console.log(`✅ Indexed ${records.length} records for "${post.title}".`);
    return{statusCode:200,body:`Indexed ${records.length} chunks for ${post.title}`};
  }catch(e){
    console.error('ALGOLIA_ERROR',e);
    return{statusCode:500,body:JSON.stringify({error:e.message})};
  }
};
