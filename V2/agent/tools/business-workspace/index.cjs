const {appendFileSync,mkdirSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');

exports.inject=['tools'];
exports.apply=async function(ctx){
  const root=process.env.SPUR_BUSINESS_ROOT;
  const runDir=process.env.SPUR_RESEARCH_OUTPUT;
  if(!root || !runDir)throw new Error('Business workspace and task output must be configured by the server.');
  const taskKey=process.env.SPUR_BUSINESS_TASK_ID || resolve(runDir);
  const service=await import(pathToFileURL(resolve(__dirname,'../../../web/business-tools.mjs')).href);
  mkdirSync(runDir,{recursive:true});
  const log=event=>appendFileSync(join(runDir,'tool-events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  for(const descriptor of await service.catalog(root)){
    if(!descriptor.enabled)continue;
    // register() receives raw JSON Schema. The property-map DSL belongs to
    // Harness defineTool(), which is deliberately not a runtime dependency here.
    // Keep its supported schema subset; bounds are enforced by our dispatcher.
    const properties=Object.fromEntries(Object.entries(descriptor.parameters.properties).map(([key,schema])=>{
      const node=key==='data'?{type:'string',description:'JSON-encoded object of writable business fields; call business_schema first.'}:
        Object.fromEntries(Object.entries(schema).filter(([field])=>['type','enum','const','description','title','default','examples'].includes(field)));
      if(key==='kind')node.enum=descriptor.allowed_kinds;
      const bounds=[schema.minLength!==undefined?`Minimum length: ${schema.minLength}.`:'',
        schema.maxLength!==undefined?`Maximum length: ${schema.maxLength}.`:'',
        schema.minimum!==undefined?`Minimum: ${schema.minimum}.`:'',schema.maximum!==undefined?`Maximum: ${schema.maximum}.`:''].filter(Boolean);
      if(bounds.length)node.description=[node.description,...bounds].filter(Boolean).join(' ');
      return [key,node];
    }));
    const parameters={type:'object',properties,required:descriptor.parameters.required,additionalProperties:false};
    ctx.tools.register({name:descriptor.name,description:descriptor.description,parameters,output,async execute(args){
      const callId=randomUUID();
      // Record operation metadata, not contact details, financial values or drafts.
      log({event:'call',id:callId,tool:descriptor.name,risk:descriptor.risk});
      try{
        const result=await service.execute(root,descriptor.name,args,service.requestKey(taskKey,descriptor.name,args));
        log({event:'result',id:callId,tool:descriptor.name,available:result.ok,
          ...(result.ok?{}:{error_code:result.error.code,status:result.error.status})});
        return result;
      }catch(error){
        log({event:'result',id:callId,tool:descriptor.name,available:false,error_code:'invalid_arguments'});
        return {ok:false,error:{code:'invalid_arguments',status:422,message:error.message}};
      }
    }});
  }
};
