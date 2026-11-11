import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, setDoc
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import firebaseConfig from "./firebase-config.js";

const configured = firebaseConfig.apiKey !== "SUA_API_KEY" && firebaseConfig.projectId !== "SEU_PROJECT_ID";
const authView = document.querySelector("#authView");
const appView = document.querySelector("#appView");
const authForm = document.querySelector("#authForm");
const toast = document.querySelector("#toast");
let auth, db, currentUser = null, tasks = [], unsubscribeBoard = null;
let mode = "login", saveQueue = Promise.resolve(), toastTimer, draggedId = null;

const statusNames = { todo: "A Fazer", doing: "Em Andamento", done: "Concluído" };
const statusKeys = Object.keys(statusNames);
const $ = selector => document.querySelector(selector);

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}
function setSync(message, online = false) {
  $("#syncStatus").textContent = message;
  $("#syncStatus").classList.toggle("online", online);
}
function setAuthMode(next) {
  mode = next;
  const login = mode === "login";
  $("#authEyebrow").textContent = login ? "BEM-VINDO DE VOLTA" : "COMECE POR AQUI";
  $("#authTitle").textContent = login ? "Acesse sua conta" : "Crie sua conta";
  $("#authSubtitle").textContent = login ? "Entre para continuar de onde você parou." : "Crie seu espaço pessoal para organizar tarefas.";
  $("#authSubmit").innerHTML = login ? 'Entrar <span>→</span>' : 'Criar conta <span>→</span>';
  $("#switchText").textContent = login ? "Ainda não tem uma conta?" : "Já tem uma conta?";
  $("#switchMode").textContent = login ? "Criar conta" : "Fazer login";
  $("#forgotPassword").hidden = !login;
  $("#password").autocomplete = login ? "current-password" : "new-password";
}
$("#switchMode").addEventListener("click", () => setAuthMode(mode === "login" ? "register" : "login"));
$("#togglePassword").addEventListener("click", () => {
  const input = $("#password");
  input.type = input.type === "password" ? "text" : "password";
  $("#togglePassword").setAttribute("aria-label", input.type === "password" ? "Mostrar senha" : "Ocultar senha");
});
$("#forgotPassword").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  if (!email) return notify("Digite seu e-mail primeiro.");
  try { await sendPasswordResetEmail(auth, email); notify("Enviamos um link de redefinição para seu e-mail."); }
  catch (error) { notify(authError(error)); }
});

function authError(error) {
  const messages = {
    "auth/invalid-email": "Confira o formato do e-mail.",
    "auth/user-not-found": "Não encontramos uma conta com esse e-mail.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Este e-mail já possui cadastro. Tente entrar.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente novamente."
  };
  return messages[error.code] || "Não foi possível concluir. Confira os dados e tente novamente.";
}

authForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!configured) return notify("Antes, configure o Firebase no arquivo firebase-config.js.");
  const email = $("#email").value.trim();
  const password = $("#password").value;
  $("#authSubmit").disabled = true;
  try {
    if (mode === "register") await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
  } catch (error) { notify(authError(error)); }
  finally { $("#authSubmit").disabled = false; }
});

function showApp(user) {
  currentUser = user;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  const initial = (user.email || "U").charAt(0).toUpperCase();
  $("#userAvatar").textContent = initial;
  $("#topAvatar").textContent = initial;
  $("#userEmail").textContent = user.email || "Minha conta";
  $("#todayLabel").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());
  if (unsubscribeBoard) unsubscribeBoard();
  const ref = doc(db, "users", user.uid, "kanban", "state");
  setSync("Sincronizando...");
  unsubscribeBoard = onSnapshot(ref, snapshot => {
    tasks = snapshot.exists() && Array.isArray(snapshot.data().tasks) ? snapshot.data().tasks : [];
    render();
    setSync("Dados sincronizados", true);
    if (!snapshot.exists()) persistTasks();
  }, error => {
    console.error(error);
    setSync("Falha na sincronização");
    notify("Não foi possível carregar seus dados. Confira as regras do Firestore.");
  });
}
function persistTasks() {
  if (!currentUser) return;
  const ref = doc(db, "users", currentUser.uid, "kanban", "state");
  const payload = { tasks, updatedAt: new Date().toISOString() };
  saveQueue = saveQueue.then(() => setDoc(ref, payload)).catch(error => {
    console.error(error); setSync("Erro ao salvar"); notify("Não foi possível salvar. Verifique sua conexão e as regras.");
  });
}
function createCard(task) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.draggable = true;
  card.dataset.id = task.id;
  const top = document.createElement("div"); top.className = "task-card-top";
  const title = document.createElement("h4"); title.textContent = task.title;
  const del = document.createElement("button"); del.className = "delete-task"; del.type = "button";
  del.textContent = "×"; del.title = "Excluir tarefa"; del.setAttribute("aria-label", `Excluir ${task.title}`);
  del.addEventListener("click", () => deleteTask(task.id));
  top.append(title, del); card.append(top);
  if (task.description) { const p = document.createElement("p"); p.textContent = task.description; card.append(p); }
  const select = document.createElement("select"); select.setAttribute("aria-label", `Status de ${task.title}`);
  statusKeys.forEach(key => { const option = document.createElement("option"); option.value = key; option.textContent = statusNames[key]; option.selected = task.status === key; select.append(option); });
  select.addEventListener("change", () => moveTask(task.id, select.value)); card.append(select);
  card.addEventListener("dragstart", event => { draggedId = task.id; card.classList.add("dragging"); event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; });
  card.addEventListener("dragend", () => { draggedId = null; card.classList.remove("dragging"); document.querySelectorAll(".column").forEach(c => c.classList.remove("drag-over")); });
  return card;
}
function render() {
  statusKeys.forEach(status => {
    const list = $(`#list-${status}`);
    list.replaceChildren();
    const matching = tasks.filter(task => task.status === status);
    $(`#count-${status}`).textContent = matching.length;
    if (!matching.length) { const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "Nenhuma tarefa por aqui"; list.append(empty); }
    matching.forEach(task => list.append(createCard(task)));
  });
  $("#totalCount").textContent = tasks.length;
  $("#doingCount").textContent = tasks.filter(t => t.status === "doing").length;
  $("#doneCount").textContent = tasks.filter(t => t.status === "done").length;
}
function moveTask(id, status) {
  if (!statusKeys.includes(status)) return;
  const task = tasks.find(item => item.id === id);
  if (!task || task.status === status) return;
  tasks = tasks.map(item => item.id === id ? { ...item, status } : item);
  render(); persistTasks(); notify(`Tarefa movida para ${statusNames[status]}.`);
}
async function deleteTask(id) {
  const task = tasks.find(item => item.id === id);
  if (!task || !confirm(`Excluir a tarefa "${task.title}"?`)) return;
  tasks = tasks.filter(item => item.id !== id);
  render(); persistTasks(); notify("Tarefa excluída.");
}

const modal = $("#taskModal");
function openModal(status = "todo") { $("#taskForm").reset(); $("#taskStatus").value = status; modal.classList.add("open"); setTimeout(() => $("#taskTitle").focus(), 20); }
function closeModal() { modal.classList.remove("open"); $("#addTaskBtn").focus(); }
$("#addTaskBtn").addEventListener("click", () => openModal());
document.querySelectorAll("[data-add-status]").forEach(button => button.addEventListener("click", () => openModal(button.dataset.addStatus)));
$("#closeModal").addEventListener("click", closeModal);
$("#cancelModal").addEventListener("click", closeModal);
modal.addEventListener("click", event => { if (event.target === modal) closeModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && modal.classList.contains("open")) closeModal(); });
$("#taskForm").addEventListener("submit", event => {
  event.preventDefault();
  const title = $("#taskTitle").value.trim();
  if (!title) return;
  tasks = [{ id: crypto.randomUUID(), title, description: $("#taskDescription").value.trim(), status: $("#taskStatus").value, createdAt: new Date().toISOString() }, ...tasks];
  render(); persistTasks(); closeModal(); notify("Tarefa adicionada.");
});
document.querySelectorAll(".column").forEach(column => {
  column.addEventListener("dragover", event => { event.preventDefault(); column.classList.add("drag-over"); event.dataTransfer.dropEffect = "move"; });
  column.addEventListener("dragleave", event => { if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over"); });
  column.addEventListener("drop", event => { event.preventDefault(); column.classList.remove("drag-over"); const id = event.dataTransfer.getData("text/plain") || draggedId; if (id) moveTask(id, column.dataset.status); });
});
$("#logoutBtn").addEventListener("click", async () => { if (unsubscribeBoard) unsubscribeBoard(); await signOut(auth); });
setAuthMode("login");

if (!configured) {
  setSync("Configuração pendente");
  console.warn("Configure firebase-config.js antes de usar autenticação e sincronização.");
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, user => {
    if (user) showApp(user);
    else {
      currentUser = null; tasks = [];
      if (unsubscribeBoard) { unsubscribeBoard(); unsubscribeBoard = null; }
      appView.classList.add("hidden"); authView.classList.remove("hidden");
      setAuthMode("login");
    }
  });
}
