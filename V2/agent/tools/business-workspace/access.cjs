/** Current workspace AI grants for existing provider tools. */
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');

let service;
function currentService(){
  return service ??= import(pathToFileURL(resolve(__dirname,'../../../web/business-tools.mjs')).href);
}

exports.integrationToolVisible=function integrationToolVisible(permission='ai_read'){
  // Standalone connector consumers have their own access policy. The canonical
  // web host opts into this guard by supplying the fixed workspace root.
  if(!process.env.SPUR_BUSINESS_ROOT)return true;
  return process.env.SPUR_INTEGRATIONS_AI_READ==='1' &&
    (permission!=='ai_write' || process.env.SPUR_INTEGRATIONS_AI_WRITE==='1');
};

exports.assertIntegrationAccess=async function assertIntegrationAccess(permission='ai_read'){
  const root=process.env.SPUR_BUSINESS_ROOT;
  if(!root)return;
  if(!['ai_read','ai_write'].includes(permission))throw new Error('Unsupported integration permission.');
  try{
    // assertModuleAccess also enforces the global ai_enabled switch. Snapshot
    // environment flags only hide tools; they never grant execution access.
    await (await currentService()).assertModuleAccess(root,'integrations',permission);
  }catch(cause){
    const status=Number.isInteger(cause.status)?cause.status:503;
    const error=new Error(status>=500?'Integration access could not be verified. Retry after the business service is available.':cause.message);
    error.status=status;error.code=cause.code || 'permission_denied';
    throw error;
  }
};
