document.addEventListener("DOMContentLoaded", async () => {
 const form=document.getElementById("socialLinksForm"); if(!form)return;
 const fields={tiktok:document.getElementById("socialTikTok"),instagram:document.getElementById("socialInstagram"),facebook:document.getElementById("socialFacebook"),x:document.getElementById("socialX"),email:document.getElementById("socialEmail")};
 const message=(text,type="error")=>{const el=document.getElementById("settingsMessage");if(el){el.textContent=text;el.className=`admin-message ${type}`;el.style.display="block";}};
 const request=async(path,options={})=>{const r=await GasHubAdmin.adminApiRequest(path,options);return r;};
 try{const d=await request("/api/admin/settings/social");const links=d.social_links||{};Object.keys(fields).forEach(k=>fields[k].value=String(links[k]||"").replace(/^mailto:/i,""));}catch(e){message(e.message||"Could not load social media settings.");}
 form.addEventListener("submit",async e=>{e.preventDefault();const links={};Object.keys(fields).forEach(k=>links[k]=fields[k].value.trim());try{const d=await request("/api/admin/settings/social",{method:"PUT",body:JSON.stringify({social_links:links})});message(d.message||"Social links saved.","success");}catch(err){message(err.message||"Could not save social links.");}});
});
