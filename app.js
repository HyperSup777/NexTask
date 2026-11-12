import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import firebaseConfig from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const statusNames = { todo:"A Fazer", doing:"Em Andamento", done:"Concluído" };
const roleNames = { OWNER:"Dono", EDITOR:"Editor", VIEWER:"Leitor" };
let user=null, boards=[], currentBoard=null, members=[], tasks=[], invites=[];
let boardUnsub=null, taskUnsub=null, memberUnsub=null, inviteUnsub=null;
let mode="login", selectedTask=null, detailUnsub=null, commentUnsub=null;
let canEdit=false, isOwner=false, currentRouteTask=null, saveBusy=false;

const toast = (message) => {
  const el=$("#toast"); el.textContent=message; el.classList.add("show");
  clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>el.classList.remove("show"),3000);
};
const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dateText = value => value ? new Date(value).toLocaleDateString("pt-BR") : "Sem prazo";
const id = () => crypto.randomUUID();
const userMembershipRef = boardId => doc(db,"users",user.uid,"memberships",boardId);
const boardRef = boardId => doc(db,"boards",boardId);
const taskRef = taskId => doc(db,"tasks",taskId);

function setAuthMode(next){
  mode=next; const login=mode==="login";
  $("#authEyebrow").textContent=login?"BEM-VINDO DE VOLTA":"COMECE POR AQUI";
  $("#authTitle").textContent=login?"Acesse sua conta":"Crie sua conta";
  $("#authSubtitle").textContent=login?"Entre para continuar de onde você parou.":"Crie seu espaço para organizar e compartilhar tarefas.";
  $("#authSubmit").textContent=login?"Entrar →":"Criar conta →";
  $("#switchText").textContent=login?"Ainda não tem uma conta?":"Já tem uma conta?";
  $("#switchMode").textContent=login?"Criar conta":"Fazer login";
  $("#forgotPassword").hidden=!login;
}
$("#switchMode").onclick=()=>setAuthMode(mode==="login"?"register":"login");
$("#authForm").addEventListener("submit",async e=>{
  e.preventDefault(); const email=$("#email").value.trim(), password=$("#password").value;
  $("#authSubmit").disabled=true;
  try { if(mode==="register") await createUserWithEmailAndPassword(auth,email,password); else await signInWithEmailAndPassword(auth,email,password); }
  catch(err){toast(authError(err));} finally{$("#authSubmit").disabled=false;}
});
$("#forgotPassword").onclick=async()=>{
  const email=$("#email").value.trim(); if(!email)return toast("Digite seu e-mail primeiro.");
  try{await sendPasswordResetEmail(auth,email);toast("Link de redefinição enviado.");}catch(e){toast(authError(e));}
};
function authError(e){
  const m={"auth/invalid-email":"Confira o e-mail.","auth/user-not-found":"Conta não encontrada.","auth/wrong-password":"E-mail ou senha incorretos.","auth/invalid-credential":"E-mail ou senha incorretos.","auth/email-already-in-use":"Esse e-mail já está cadastrado.","auth/weak-password":"Use uma senha com pelo menos 6 caracteres.","auth/network-request-failed":"Falha de conexão."};
  return m[e.code]||"Não foi possível concluir. Confira os dados e tente novamente.";
}

function show(view){
  $("#authView").classList.toggle("hidden",view!=="auth");
  $("#appView").classList.toggle("hidden",view!=="app");
  $("#taskDetailView").classList.toggle("hidden",view!=="task");
}
function cleanup(){
  [boardUnsub,taskUnsub,memberUnsub,inviteUnsub,detailUnsub,commentUnsub].forEach(fn=>{if(fn)fn();});
  boardUnsub=taskUnsub=memberUnsub=inviteUnsub=detailUnsub=commentUnsub=null;
}
async function ensurePersonalBoard(){
  const memberships=await getDocs(collection(db,"users",user.uid,"memberships"));
  if(!memberships.empty)return;
  const oldRef=doc(db,"users",user.uid,"kanban","state");
  const oldSnap=await getDoc(oldRef);
  const oldTasks=oldSnap.exists()&&Array.isArray(oldSnap.data().tasks)?oldSnap.data().tasks:[];
  const boardId=id(), b=writeBatch(db);
  b.set(boardRef(boardId),{name:"Meu primeiro quadro",ownerId:user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),wip:{todo:0,doing:0,done:0}});
  b.set(doc(db,"boards",boardId,"members",user.uid),{userId:user.uid,email:user.email,role:"OWNER",joinedAt:serverTimestamp()});
  b.set(userMembershipRef(boardId),{boardId,name:"Meu primeiro quadro",ownerId:user.uid,role:"OWNER",joinedAt:serverTimestamp()});
  oldTasks.forEach(t=>{
    const taskId=t.id||id();
    b.set(taskRef(taskId),{...t,id:taskId,boardId,createdBy:user.uid,assigneeId:"",priority:t.priority||"medium",labels:t.labels||[],checklist:t.checklist||[],commentsCount:0,updatedAt:serverTimestamp()});
  });
  await b.commit();
}
async function loadWorkspace(){
  await ensurePersonalBoard();
  const mref=collection(db,"users",user.uid,"memberships");
  boardUnsub=onSnapshot(mref,async snap=>{
    boards=snap.docs.map(d=>({id:d.id,...d.data()}));
    renderBoardList();
    if(!currentBoard||!boards.some(b=>b.id===currentBoard.id)){
      const first=boards[0]; if(first) await selectBoard(first.id); else {currentBoard=null;renderBoard();}
    } else {
      const fresh=boards.find(b=>b.id===currentBoard.id); currentBoard={...currentBoard,...fresh}; renderBoardHeader();
    }
  },e=>{console.error(e);toast("Erro ao carregar seus quadros.");});
  const qInv=query(collection(db,"invites"),where("email","==",user.email.toLowerCase()),where("status","==","pending"));
  inviteUnsub=onSnapshot(qInv,s=>{invites=s.docs.map(d=>({id:d.id,...d.data()}));renderInvites();},e=>console.warn(e));
}
function renderBoardList(){
  const own=boards.filter(b=>b.ownerId===user.uid), shared=boards.filter(b=>b.ownerId!==user.uid);
  const renderGroup=(arr)=>arr.map(b=>`<button class="board-link ${currentBoard?.id===b.id?"selected":""}" data-board="${b.id}"><span>▦</span><span>${safe(b.name||"Quadro")}</span></button>`).join("")||'<small class="muted empty-small">Nenhum quadro</small>';
  $("#myBoards").innerHTML=renderGroup(own); $("#sharedBoards").innerHTML=renderGroup(shared);
  $$(".board-link").forEach(el=>el.onclick=()=>selectBoard(el.dataset.board));
}
function renderInvites(){
  $("#inviteInbox").innerHTML=invites.map(i=>`<div class="invite-item"><div><strong>${safe(i.boardName||"Quadro compartilhado")}</strong><small>Convite de ${safe(i.inviterEmail||"um usuário")} · ${roleNames[i.role]||"Leitor"}</small></div><button class="btn btn-small btn-primary" data-accept="${i.id}">Aceitar</button></div>`).join("");
  $$("[data-accept]").forEach(b=>b.onclick=()=>acceptInvite(b.dataset.accept));
}
async function acceptInvite(inviteId){
  try{
    const ref=doc(db,"invites",inviteId), snap=await getDoc(ref);
    if(!snap.exists())throw new Error("Convite não encontrado.");
    const inv=snap.data();
    if(inv.email!==user.email.toLowerCase()||inv.status!=="pending")throw new Error("Este convite não está mais disponível.");
    const batch=writeBatch(db);
    batch.update(ref,{status:"accepted",acceptedBy:user.uid,acceptedAt:serverTimestamp()});
    batch.set(doc(db,"boards",inv.boardId,"members",user.uid),{userId:user.uid,email:user.email,role:inv.role,inviteId,joinedAt:serverTimestamp()});
    batch.set(userMembershipRef(inv.boardId),{boardId:inv.boardId,name:inv.boardName,ownerId:inv.ownerId,role:inv.role,joinedAt:serverTimestamp()});
    await batch.commit();toast("Você entrou no quadro compartilhado!");
  }catch(e){console.error(e);toast(e.message||"Não foi possível aceitar o convite.");}
}
async function selectBoard(boardId){
  const b=boards.find(x=>x.id===boardId);if(!b)return;
  cleanup();currentBoard=b;isOwner=b.ownerId===user.uid;canEdit=b.role!=="VIEWER"||isOwner;
  renderBoardList();renderBoardHeader();
  memberUnsub=onSnapshot(collection(db,"boards",boardId,"members"),s=>{members=s.docs.map(d=>({id:d.id,...d.data()}));renderMembers();renderBoard();},e=>console.warn(e));
  taskUnsub=onSnapshot(query(collection(db,"tasks"),where("boardId","==",boardId)),s=>{
    tasks=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
    renderBoard();
  },e=>{console.error(e);toast("Não foi possível carregar as tarefas.");});
  if(isOwner){
    inviteUnsub=onSnapshot(query(collection(db,"invites"),where("boardId","==",boardId),where("status","==","pending")),s=>{renderPendingInvites(s.docs.map(d=>({id:d.id,...d.data()})));},e=>console.warn(e));
  }else{$("#pendingInvites").innerHTML="";}
}
function renderBoardHeader(){
  if(!currentBoard)return;
  $("#boardName").textContent=currentBoard.name||"Quadro";
  $("#boardRole").textContent=roleNames[currentBoard.role]||"Dono";
  $("#boardOwner").textContent=isOwner?"Você é o dono": "Quadro compartilhado";
  $("#inviteBtn").hidden=!isOwner;$("#manageMembersBtn").hidden=!isOwner;
  $("#addTaskBtn").hidden=!canEdit;
}
function renderMembers(){
  $("#memberList").innerHTML=members.map(m=>`<div class="member-row"><div class="member-avatar">${safe((m.email||"?")[0].toUpperCase())}</div><div class="member-info"><strong>${safe(m.email||"Membro")}</strong><small>${roleNames[m.role]||m.role}${m.userId===user.uid?" · Você":""}</small></div>${isOwner&&m.userId!==user.uid?`<select data-role="${m.userId}" aria-label="Papel de ${safe(m.email)}"><option value="EDITOR" ${m.role==="EDITOR"?"selected":""}>Editor</option><option value="VIEWER" ${m.role==="VIEWER"?"selected":""}>Leitor</option></select><button class="icon-btn danger" data-remove="${m.userId}" title="Remover acesso">×</button>`:""}</div>`).join("");
  $$("[data-role]").forEach(s=>s.onchange=()=>changeRole(s.dataset.role,s.value));
  $$("[data-remove]").forEach(b=>b.onclick=()=>removeMember(b.dataset.remove));
}
function renderPendingInvites(list){
  $("#pendingInvites").innerHTML=list.map(i=>`<div class="pending-row"><span>${safe(i.email)}</span><small>Convite pendente · ${roleNames[i.role]}</small><button class="text-button" data-cancel-invite="${i.id}">Cancelar</button></div>`).join("");
  $$("[data-cancel-invite]").forEach(b=>b.onclick=async()=>{try{await deleteDoc(doc(db,"invites",b.dataset.cancelInvite));toast("Convite cancelado.");}catch(e){toast("Não foi possível cancelar.");}});
}
async function changeRole(uid,role){
  try{
    const batch=writeBatch(db);
    batch.update(doc(db,"boards",currentBoard.id,"members",uid),{role});
    batch.update(doc(db,"users",uid,"memberships",currentBoard.id),{role});
    await batch.commit();toast("Permissão atualizada.");
  }catch(e){console.error(e);toast("Não foi possível alterar a permissão.");}
}
async function removeMember(uid){
  if(!confirm("Remover este usuário do quadro?"))return;
  try{
    const batch=writeBatch(db);
    batch.delete(doc(db,"boards",currentBoard.id,"members",uid));
    batch.delete(doc(db,"users",uid,"memberships",currentBoard.id));
    await batch.commit();toast("Acesso removido.");
  }catch(e){console.error(e);toast("Não foi possível remover o acesso.");}
}
async function createBoard(){
  const name=prompt("Nome do novo quadro:");if(!name?.trim())return;
  try{
    const boardId=id(),batch=writeBatch(db);
    batch.set(boardRef(boardId),{name:name.trim(),ownerId:user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),wip:{todo:0,doing:0,done:0}});
    batch.set(doc(db,"boards",boardId,"members",user.uid),{userId:user.uid,email:user.email,role:"OWNER",joinedAt:serverTimestamp()});
    batch.set(userMembershipRef(boardId),{boardId,name:name.trim(),ownerId:user.uid,role:"OWNER",joinedAt:serverTimestamp()});
    await batch.commit();toast("Quadro criado!");
  }catch(e){console.error(e);toast("Não foi possível criar o quadro.");}
}
async function sendInvite(){
  if(!isOwner)return;
  const email=$("#inviteEmail").value.trim().toLowerCase(),role=$("#inviteRole").value;
  if(!email||email===user.email.toLowerCase())return toast("Digite o e-mail de outra pessoa.");
  try{
    const existing=members.find(m=>m.email?.toLowerCase()===email);
    if(existing)return toast("Essa pessoa já participa do quadro.");
    const dup=query(collection(db,"invites"),where("boardId","==",currentBoard.id),where("email","==",email),where("status","==","pending"));
    if(!(await getDocs(dup)).empty)return toast("Já existe um convite pendente para esse e-mail.");
    await addDoc(collection(db,"invites"),{boardId:currentBoard.id,boardName:currentBoard.name,ownerId:user.uid,email,role,status:"pending",inviterEmail:user.email,createdAt:serverTimestamp()});
    $("#inviteEmail").value="";$("#inviteModal").classList.remove("open");toast("Convite enviado! A pessoa verá o convite ao entrar com esse e-mail.");
  }catch(e){console.error(e);toast("Não foi possível enviar. Confira as regras do Firestore.");}
}

function renderBoard(){
  if(!currentBoard)return;
  const queryText=$("#taskSearch").value.trim().toLowerCase();
  const backlogOnly=$("#backlogToggle").checked;
  ["todo","doing","done"].forEach(status=>{
    const list=$("#list-"+status);list.replaceChildren();
    const filtered=tasks.filter(t=>t.status===status&&(!backlogOnly||t.backlog)&&(!queryText||[t.title,t.description,...(t.labels||[])].join(" ").toLowerCase().includes(queryText)));
    $("#count-"+status).textContent=filtered.length;
    filtered.forEach(t=>list.append(createTaskCard(t)));
    if(!filtered.length){const empty=document.createElement("div");empty.className="empty-state";empty.textContent="Nenhuma tarefa por aqui";list.append(empty);}
  });
  $("#totalCount").textContent=tasks.length;$("#doingCount").textContent=tasks.filter(t=>t.status==="doing").length;$("#doneCount").textContent=tasks.filter(t=>t.status==="done").length;
  $("#boardWip").textContent=Object.entries(currentBoard.wip||{}).filter(([,v])=>v>0).map(([k,v])=>statusNames[k]+": "+v).join(" · ")||"Sem limites WIP";
  $("#boardDate").textContent=new Intl.DateTimeFormat("pt-BR",{dateStyle:"long"}).format(new Date());
}
function createTaskCard(t){
  const el=document.createElement("article");el.className="task-card";el.dataset.id=t.id;el.draggable=canEdit;
  const labels=(t.labels||[]).map(x=>`<span class="label-chip">${safe(x)}</span>`).join("");
  const priority={low:"Baixa",medium:"Média",high:"Alta"}[t.priority]||"Média";
  el.innerHTML=`<div class="task-card-top"><h4>${safe(t.title)}</h4><button class="delete-task" type="button" title="Excluir tarefa" ${canEdit?"":"hidden"}>×</button></div>
    <p class="task-description">${safe(t.description||"")}</p><div class="task-tags">${labels}</div>
    <div class="task-meta"><span class="priority p-${safe(t.priority||"medium")}">${priority}</span><span>◷ ${dateText(t.dueDate)}</span></div>
    <div class="task-card-bottom"><small>${safe(t.assigneeEmail||"Sem responsável")}</small><button class="open-task" type="button">Abrir tarefa ↗</button></div>
    ${canEdit?`<select class="status-select" aria-label="Status"><option value="todo" ${t.status==="todo"?"selected":""}>A Fazer</option><option value="doing" ${t.status==="doing"?"selected":""}>Em Andamento</option><option value="done" ${t.status==="done"?"selected":""}>Concluído</option></select>`:""}`;
  el.querySelector(".open-task").onclick=()=>openTaskPage(t.id);
  el.querySelector(".delete-task")?.addEventListener("click",e=>{e.stopPropagation();deleteTask(t.id);});
  el.querySelector(".status-select")?.addEventListener("change",e=>updateTask(t.id,{status:e.target.value}));
  el.addEventListener("click",e=>{if(!e.target.closest("button,select"))openTaskPage(t.id);});
  el.addEventListener("dragstart",e=>{e.dataTransfer.setData("text/plain",t.id);});
  return el;
}
async function createTask(){
  if(!canEdit)return;
  const title=$("#taskTitle").value.trim();if(!title)return;
  try{
    await addDoc(collection(db,"tasks"),{boardId:currentBoard.id,title,description:$("#taskDescription").value.trim(),status:$("#taskStatus").value,createdBy:user.uid,createdByEmail:user.email,assigneeId:"",assigneeEmail:"",dueDate:"",priority:"medium",labels:[],checklist:[],backlog:false,sprint:"",storyPoints:0,acceptanceCriteria:"",definitionOfDone:"",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    $("#taskModal").classList.remove("open");$("#taskForm").reset();toast("Tarefa criada.");
  }catch(e){console.error(e);toast("Não foi possível criar a tarefa.");}
}
async function updateTask(taskId,patch){
  if(!canEdit)return;
  try{await updateDoc(taskRef(taskId),{...patch,updatedAt:serverTimestamp()});}
  catch(e){console.error(e);toast("Não foi possível atualizar a tarefa.");}
}
async function deleteTask(taskId){
  if(!canEdit||!confirm("Excluir esta tarefa e seus comentários?"))return;
  try{
    const comments=await getDocs(collection(db,"tasks",taskId,"comments"));
    const batch=writeBatch(db);comments.forEach(d=>batch.delete(d.ref));batch.delete(taskRef(taskId));await batch.commit();toast("Tarefa excluída.");
  }catch(e){console.error(e);toast("Não foi possível excluir a tarefa.");}
}
function openTaskPage(taskId){
  const url=new URL(location.href);url.searchParams.set("task",taskId);
  window.open(url.toString(),"_blank","noopener");
}
function openTaskModal(){ $("#taskModal").classList.add("open"); }
function renderTaskDetail(task){
  selectedTask=task;
  $("#taskDetailTitle").textContent=task.title||"Tarefa";
  $("#taskDetailDescription").value=task.description||"";
  $("#detailDueDate").value=task.dueDate||"";
  $("#detailPriority").value=task.priority||"medium";
  $("#detailLabels").value=(task.labels||[]).join(", ");
  $("#detailBacklog").checked=!!task.backlog;
  $("#detailSprint").value=task.sprint||"";
  $("#detailPoints").value=task.storyPoints||0;
  $("#detailCriteria").value=task.acceptanceCriteria||"";
  $("#detailDone").value=task.definitionOfDone||"";
  const editable=canEdit;
  ["taskDetailDescription","detailDueDate","detailPriority","detailLabels","detailBacklog","detailSprint","detailPoints","detailCriteria","detailDone","saveTaskDetail"].forEach(id=>$("#"+id).disabled=!editable);
  $("#detailAssignee").innerHTML='<option value="">Sem responsável</option>'+members.map(m=>`<option value="${m.userId}" ${task.assigneeId===m.userId?"selected":""}>${safe(m.email)}</option>`).join("");
  $("#detailAssignee").disabled=!editable;
  $("#detailAssignee").onchange=()=>{const m=members.find(x=>x.userId===$("#detailAssignee").value);updateTask(task.id,{assigneeId:m?.userId||"",assigneeEmail:m?.email||""});};
  $("#detailStatus").textContent=statusNames[task.status]||"A Fazer";
  $("#detailRoleNote").textContent=canEdit?"Você pode editar esta tarefa.":"Acesso de leitura: você não pode editar esta tarefa.";
  $("#taskDetailView").classList.remove("hidden");
  loadComments(task.id);
}
function loadComments(taskId){
  if(commentUnsub)commentUnsub();
  commentUnsub=onSnapshot(query(collection(db,"tasks",taskId,"comments"),orderBy("createdAt","asc")),snap=>{
    $("#commentsList").innerHTML=snap.docs.map(d=>{const c=d.data();return `<div class="comment"><strong>${safe(c.authorEmail||"Usuário")}</strong><small>${c.createdAt?.toDate?c.createdAt.toDate().toLocaleString("pt-BR"):"Agora"}</small><p>${safe(c.text)}</p></div>`;}).join("")||'<p class="muted">Ainda não há comentários.</p>';
  },e=>console.warn(e));
}
async function saveTaskDetail(){
  if(!selectedTask||!canEdit)return;
  const labels=$("#detailLabels").value.split(",").map(s=>s.trim()).filter(Boolean);
  await updateTask(selectedTask.id,{
    description:$("#taskDetailDescription").value.trim(),dueDate:$("#detailDueDate").value,
    priority:$("#detailPriority").value,labels,backlog:$("#detailBacklog").checked,
    sprint:$("#detailSprint").value.trim(),storyPoints:Number($("#detailPoints").value)||0,
    acceptanceCriteria:$("#detailCriteria").value.trim(),definitionOfDone:$("#detailDone").value.trim()
  });
  toast("Detalhes salvos.");
}
async function addComment(){
  if(!selectedTask)return;
  const textValue=$("#commentText").value.trim();if(!textValue)return;
  try{await addDoc(collection(db,"tasks",selectedTask.id,"comments"),{text:textValue,authorId:user.uid,authorEmail:user.email,createdAt:serverTimestamp()});$("#commentText").value="";}
  catch(e){console.error(e);toast("Não foi possível enviar o comentário.");}
}
async function openRouteTask(){
  const taskId=new URLSearchParams(location.search).get("task");if(!taskId)return;
  currentRouteTask=taskId;
  show("task");
  detailUnsub=onSnapshot(taskRef(taskId),async snap=>{
    if(!snap.exists()){toast("Tarefa não encontrada.");return;}
    const task={id:snap.id,...snap.data()};
    const mem=await getDoc(userMembershipRef(task.boardId));
    if(!mem.exists()){toast("Você não tem acesso a esta tarefa.");return;}
    currentBoard={id:task.boardId,...(await (async()=>{const b=await getDoc(boardRef(task.boardId));return b.exists()?b.data():{};})()),...mem.data()};
    members=(await getDocs(collection(db,"boards",task.boardId,"members"))).docs.map(d=>({id:d.id,...d.data()}));
    canEdit=mem.data().role!=="VIEWER";isOwner=mem.data().role==="OWNER";
    renderTaskDetail(task);
  },e=>{console.error(e);toast("Sem permissão para abrir esta tarefa.");});
}
function setupUI(){
  $("#logoutBtn").onclick=()=>signOut(auth);
  $("#createBoardBtn").onclick=createBoard;
  $("#inviteBtn").onclick=()=>$("#inviteModal").classList.add("open");
  $("#manageMembersBtn").onclick=()=>$("#membersModal").classList.add("open");
  $("#inviteForm").onsubmit=e=>{e.preventDefault();sendInvite();};
  $("#addTaskBtn").onclick=openTaskModal;
  $("#taskForm").onsubmit=e=>{e.preventDefault();createTask();};
  $("#closeTaskModal").onclick=()=>$("#taskModal").classList.remove("open");
  $("#cancelTaskModal").onclick=()=>$("#taskModal").classList.remove("open");
  $("#closeInviteModal").onclick=()=>$("#inviteModal").classList.remove("open");
  $("#closeMembersModal").onclick=()=>$("#membersModal").classList.remove("open");
  $("#closeDetail").onclick=()=>{if(commentUnsub)commentUnsub();history.back();};
  $("#saveTaskDetail").onclick=saveTaskDetail;
  $("#commentForm").onsubmit=e=>{e.preventDefault();addComment();};
  $("#taskSearch").oninput=renderBoard;
  $("#backlogToggle").onchange=renderBoard;
  $("#wipBtn").onclick=async()=>{
    if(!isOwner)return toast("Somente o dono pode configurar limites WIP.");
    const val=prompt("Limite de tarefas em andamento (0 = sem limite):",currentBoard.wip?.doing||0);
    if(val===null)return;const n=Math.max(0,Number(val)||0);
    try{await updateDoc(boardRef(currentBoard.id),{wip:{...(currentBoard.wip||{}),doing:n}});currentBoard.wip={...(currentBoard.wip||{}),doing:n};renderBoard();toast("Limite WIP atualizado.");}catch(e){toast("Não foi possível salvar o limite.");}
  };
  $$(".column").forEach(col=>{
    col.addEventListener("dragover",e=>{if(canEdit)e.preventDefault();});
    col.addEventListener("drop",e=>{if(!canEdit)return;e.preventDefault();const taskId=e.dataTransfer.getData("text/plain");const status=col.dataset.status;const limit=currentBoard?.wip?.[status]||0;const count=tasks.filter(t=>t.status===status&&t.id!==taskId).length;if(limit&&count>=limit)return toast("Limite WIP atingido nesta coluna.");updateTask(taskId,{status});});
  });
}
setupUI();
onAuthStateChanged(auth,async u=>{
  cleanup();user=u;
  if(!u){show("auth");return;}
  $("#userEmail").textContent=u.email||"Minha conta";
  $("#userAvatar").textContent=(u.email||"U")[0].toUpperCase();
  if(new URLSearchParams(location.search).has("task")){await openRouteTask();return;}
  show("app");
  try{await loadWorkspace();}catch(e){console.error(e);toast("Erro ao preparar seus quadros.");}
});
setAuthMode("login");
