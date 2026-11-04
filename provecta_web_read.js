// Matches the first-party Provecta web client's authentication headers.
// Only read operations are permitted; credentials never leave this service.
export function createProvectaWebRead({origin,username,password,getClient,readJson}){
 let token='',expires=0,authenticating=null;
 const headers=code=>({'Content-Type':'application/json; charset=utf-8',Accept:'application/json','X-Requested-With':'XMLHttpRequest',CultureCode:'ru',EmplacementCode:'ProvectaPOS.Central',ApplicationCode:'ProvectaPOS.Server.Iis',TokenCode:code,ClientUUID:'',ClientDevice:'',ClientPlatform:'',ClientApplication:'ProvectaPOS 238'});
 const post=(method,data,code)=>readJson(origin+'/services/'+method,{method:'POST',headers:headers(code),body:JSON.stringify(data),timeoutMs:45000},0);
 async function authenticate(){
  if(token&&expires>Date.now()+60000)return token;if(authenticating)return authenticating;
  authenticating=(async()=>{
   const value=await post('Framework/Common.svc/Web/Login',{userCode:username,userPassword:password},'');const logged=value?.LoginResult??value?.d??value;
   const loginCode=logged?.Code;if(!loginCode)throw Error('Provecta web authentication did not return a session');
   const client=await getClient();const response=await post('Framework/Common.svc/Web/Authentication',{organisation:{Id:client}},loginCode);const authenticated=response?.AuthenticationResult??response?.d??response;
   if(!authenticated?.Code)throw Error('Provecta web authentication did not confirm the organization');
   token=String(authenticated.Code);expires=Date.now()+10*60000;return token;
  })().finally(()=>authenticating=null);return authenticating;
 }
 return async(method,body)=>{
  if(!['ArticleBarcodeSearch','ArticleSearch','ArticleLoad','ArticleGroupSearch','PricelistSearch','PricelistItemSearch','GiftcardSearch','DocumentResumeSearch','LayoutSearch','TenderSearch','SchemeSearch'].includes(method))throw Error('Read operation not permitted');
  const code=await authenticate();return post((['LayoutSearch','TenderSearch','SchemeSearch'].includes(method)?'Framework/Owner.svc/Web/':'Stock.svc/Web/')+method,body,code);
 };
}
