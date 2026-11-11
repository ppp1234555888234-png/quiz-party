import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {getAuth,onAuthStateChanged,signInAnonymously,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {getDatabase,ref,set,get,update,onValue,runTransaction,push} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';
import {firebaseConfig} from './firebase-config.js';

const $=id=>document.getElementById(id);
const show=(id,v=true)=>{if($(id))$(id).classList.toggle('hidden',!v)};
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=s=>{if($('status'))$('status').textContent=s};
const inviteCode=new URLSearchParams(location.search).get('code');

let auth,db,user,host=false,quiz=null,selectedId='',libraries={},room='',roomData=null,playerId='',unsubscribe=null;
let roomQuiz=null,hostTimer=null,playerTimer=null,joining=false,reviewIndex=0,editorDirty=false;

const blankQuestion=()=>({
  prompt:'',
  options:['','','',''],
  correctIndex:0,
  explanation:'',
  timeLimit:15
});

const normalize=q=>({
  name:String(q?.name||'未命名題庫'),
  questions:Object.values(q?.questions||{}).map(x=>({
    prompt:String(x.prompt||''),
    options:Array.from({length:4},(_,i)=>String(x.options?.[i]||'')),
    correctIndex:Number(x.correctIndex)||0,
    explanation:String(x.explanation||''),
    timeLimit:Number(x.timeLimit)||15
  }))
});

const libraryPath=()=>`quizzes/${user.uid}/collections`;

const screen=id=>['home','hostLogin','host','join','player'].forEach(x=>show(x,x===id));

const err=(label,e)=>{
  console.error(label,e);
  msg(label+'：'+(e.message||e));
  alert(label+'：'+(e.message||e));
};

function beep(){
  try{
    const C=window.AudioContext||window.webkitAudioContext;
    const a=new C(),o=a.createOscillator(),g=a.createGain();
    o.connect(g);
    g.connect(a.destination);
    g.gain.value=.04;
    o.frequency.value=550;
    o.start();
    o.stop(a.currentTime+.1);
    o.onended=()=>a.close();
  }catch{}
}

function ensureUI(){
  const hostPanel=$('host');

  if(!$('libraryPanel')){
    const panel=document.createElement('div');
    panel.id='libraryPanel';
    panel.className='card';

    panel.innerHTML=`
      <h2>📚 我的題庫</h2>
      <p class="muted">選擇一份題庫，按「開始」建立房間。</p>
      <div id="libraryList"></div>
      <button id="newLibrary" class="primary">➕ 新增題庫</button>
    `;

    hostPanel.insertBefore(panel,hostPanel.children[1]||null);
    $('newLibrary').onclick=()=>createLibrary();
  }

  if(!$('editorBack')){
    const b=document.createElement('button');
    b.id='editorBack';
    b.textContent='← 返回題庫列表';
    $('editor').insertBefore(b,$('editor').firstChild);
    b.onclick=()=>closeEditor();
  }

  if(!$('selectedLibraryHint')){
    const p=document.createElement('p');
    p.id='selectedLibraryHint';
    p.className='muted';
    $('host').querySelector('.card').appendChild(p);
  }

  show('editToggle',false);
  show('createRoom',false);
}

function renderLibraries(){
  ensureUI();

  show('libraryPanel',true);
  show('editor',false);

  const ids=Object.keys(libraries);

  $('libraryList').innerHTML=ids.length
    ?ids.map(id=>{
      const q=normalize(libraries[id]);

      return `
        <div style="
          border:1px solid #dcebf9;
          border-radius:14px;
          padding:12px;
          margin:10px 0">

          <b>${safe(q.name)}</b>
          <p class="muted">${q.questions.length} 題</p>

          <div class="row">
            <button class="primary"
              data-action="start"
              data-id="${safe(id)}">
              🎮 開始
            </button>

            <button data-action="edit"
              data-id="${safe(id)}">
              ✏️ 編輯
            </button>

            <button data-action="copy"
              data-id="${safe(id)}">
              📋 複製
            </button>

            <button data-action="delete"
              data-id="${safe(id)}">
              🗑️ 刪除
            </button>
          </div>
        </div>
      `;
    }).join('')
    :'<p>目前沒有題庫，請按「新增題庫」。</p>';

  $('libraryList').querySelectorAll('[data-action]').forEach(b=>{
    b.onclick=async()=>{
      const id=b.dataset.id;
      const action=b.dataset.action;

      if(action==='edit')openEditor(id);
      if(action==='start')await createRoom(id);
      if(action==='copy')await copyLibrary(id);
      if(action==='delete')await deleteLibrary(id);
    };
  });

  $('selectedLibraryHint').textContent=
    '目前有 '+ids.length+' 份題庫';
}

async function loadLibraries(){
  ensureUI();

  const root=(await get(ref(db,`quizzes/${user.uid}`))).val()||{};

  libraries=root.collections||{};

  // 將舊版單一題庫複製到新版，不刪除原始資料
  if(!Object.keys(libraries).length && (root.questions||root.name)){
    const id=push(ref(db,libraryPath())).key;
    const legacy=normalize(root);

    await set(ref(db,`${libraryPath()}/${id}`),legacy);

    libraries[id]=legacy;
  }

  // 沒有題庫時，嘗試讀取 GitHub 預設題庫
  if(!Object.keys(libraries).length){
    try{
      const r=await fetch('./quizzes.json',{cache:'no-store'});

      if(r.ok){
        const data=await r.json();
        const initial=normalize(Array.isArray(data)?data[0]:data);

        if(initial.questions.length){
          const id=push(ref(db,libraryPath())).key;

          await set(ref(db,`${libraryPath()}/${id}`),initial);

          libraries[id]=initial;
        }
      }
    }catch(e){
      console.warn('預設題庫無法載入',e);
    }
  }

  renderLibraries();
}

async function createLibrary(){
  const name=prompt('新題庫名稱：','我的新題庫');

  if(name===null)return;

  const q={
    name:name.trim()||'未命名題庫',
    questions:[]
  };

  try{
    const id=push(ref(db,libraryPath())).key;

    await set(ref(db,`${libraryPath()}/${id}`),q);

    libraries[id]=q;

    renderLibraries();
    openEditor(id);
  }catch(e){
    err('新增題庫失敗',e);
  }
}

async function copyLibrary(id){
  const old=normalize(libraries[id]);

  const name=prompt(
    '複製後的題庫名稱：',
    old.name+'（副本）'
  );

  if(name===null)return;

  try{
    const key=push(ref(db,libraryPath())).key;

    const q={
      ...old,
      name:name.trim()||old.name+'（副本）'
    };

    await set(ref(db,`${libraryPath()}/${key}`),q);

    libraries[key]=q;

    renderLibraries();
  }catch(e){
    err('複製失敗',e);
  }
}

async function deleteLibrary(id){
  const q=libraries[id];

  if(!confirm(`確定刪除「${q.name}」嗎？刪除後無法復原。`)){
    return;
  }

  try{
    await set(ref(db,`${libraryPath()}/${id}`),null);

    delete libraries[id];

    renderLibraries();
  }catch(e){
    err('刪除失敗',e);
  }
}

function openEditor(id){
  selectedId=id;
  quiz=normalize(libraries[id]);
  editorDirty=false;

  show('libraryPanel',false);
  show('editor',true);

  $('quizName').value=quiz.name;

  renderEditor();

  $('editor').scrollIntoView({
    behavior:'smooth',
    block:'start'
  });
}

function closeEditor(){
  if(editorDirty&&!confirm('尚未儲存的修改會消失，確定返回嗎？')){
    return;
  }

  quiz=null;
  selectedId='';
  editorDirty=false;

  renderLibraries();
}

function syncEditor(){
  if(!quiz)return;

  quiz.name=$('quizName').value.trim()||'未命名題庫';

  $('questionList').querySelectorAll('[data-i]').forEach(el=>{
    const q=quiz.questions[Number(el.dataset.i)];

    if(!q)return;

    if(el.dataset.opt!==undefined){
      q.options[Number(el.dataset.opt)]=el.value;
    }else if(el.dataset.k){
      q[el.dataset.k]=
        ['correctIndex','timeLimit'].includes(el.dataset.k)
          ?Number(el.value)
          :el.value;
    }
  });
}

function renderEditor(){
  $('questionList').innerHTML=quiz.questions.map((q,i)=>`
    <div class="question-editor">
      <b>第 ${i+1} 題</b>

      <label>
        題目
        <input data-i="${i}"
          data-k="prompt"
          value="${safe(q.prompt)}">
      </label>

      ${q.options.map((o,j)=>`
        <label>
          選項 ${'ABCD'[j]}
          <input data-i="${i}"
            data-opt="${j}"
            value="${safe(o)}">
        </label>
      `).join('')}

      <label>
        正確答案
        <select data-i="${i}" data-k="correctIndex">
          ${[0,1,2,3].map(j=>`
            <option value="${j}"
              ${Number(q.correctIndex)===j?'selected':''}>
              ${'ABCD'[j]}
            </option>
          `).join('')}
        </select>
      </label>

      <label>
        答案解析
        <textarea data-i="${i}"
          data-k="explanation">${safe(q.explanation)}</textarea>
      </label>

      <label>
        作答秒數
        <input type="number"
          min="5"
          max="120"
          data-i="${i}"
          data-k="timeLimit"
          value="${q.timeLimit}">
      </label>

      <button data-del="${i}">刪除此題</button>
    </div>
  `).join('');

  $('questionList')
    .querySelectorAll('input,textarea,select')
    .forEach(x=>{
      x.addEventListener('input',()=>editorDirty=true);
    });

  $('questionList')
    .querySelectorAll('[data-del]')
    .forEach(b=>{
      b.onclick=()=>{
        syncEditor();

        if(confirm('刪除這題？')){
          quiz.questions.splice(Number(b.dataset.del),1);
          editorDirty=true;
          renderEditor();
        }
      };
    });
}

async function saveQuiz(){
  if(!selectedId)return;

  syncEditor();

  for(const q of quiz.questions){
    if(!q.prompt.trim()||q.options.some(o=>!o.trim())){
      alert('請填寫每題題目與四個選項');
      return;
    }

    if(q.timeLimit<5||q.timeLimit>120){
      alert('作答秒數請設定 5～120 秒');
      return;
    }
  }

  try{
    await set(
      ref(db,`${libraryPath()}/${selectedId}`),
      quiz
    );

    libraries[selectedId]=structuredClone(quiz);
    editorDirty=false;

    alert('題庫已儲存！');

    renderLibraries();
  }catch(e){
    err('儲存失敗',e);
  }
}

async function createRoom(id){
  try{
    const chosen=normalize(libraries[id]);

    if(!chosen.questions.length){
      alert('這份題庫沒有題目，請先編輯');
      return;
    }

    let code='';

    for(let i=0;i<20;i++){
      const c=String(Math.floor(100000+Math.random()*900000));

      if(!(await get(ref(db,'rooms/'+c))).exists()){
        code=c;
        break;
      }
    }

    if(!code)throw Error('無法產生房號');

    // 儲存當場使用的完整題目及答案
    const snapshot={
      name:chosen.name,
      questions:chosen.questions
    };

    await set(
      ref(db,`quizzes/${user.uid}/roomSnapshots/${code}`),
      snapshot
    );

    await set(ref(db,'rooms/'+code),{
      hostUid:user.uid,
      quizName:chosen.name,

      quiz:chosen.questions.map(q=>({
        prompt:q.prompt,
        options:q.options,
        timeLimit:q.timeLimit
      })),

      phase:'waiting',
      index:-1,
      createdAt:Date.now(),
      players:{},
      answers:{}
    });

    roomQuiz=snapshot;

    show('hostRoom',true);
    listenRoom(code);

    $('hostRoom').scrollIntoView({behavior:'smooth'});
  }catch(e){
    err('建立房間失敗',e);
  }
}

function listenRoom(code){
  if(unsubscribe)unsubscribe();

  room=code;

  unsubscribe=onValue(ref(db,'rooms/'+code),snap=>{
    if(!snap.exists()){
      msg('房間不存在');
      return;
    }

    roomData=snap.val();

    if(host)renderHost();
    else renderPlayer();
  },e=>err('房間連線失敗',e));
}

function renderHost(){
  $('roomCode').textContent=room;

  $('invite').value=new URL('?code='+room,location.href).href;

  if($('qr').dataset.code!==room){
    $('qr').innerHTML='';
    $('qr').dataset.code=room;

    if(window.QRCode){
      window.QRCode.toCanvas(
        $('qr').appendChild(document.createElement('canvas')),
        $('invite').value,
        {width:220,margin:2}
      ).catch(console.error);
    }
  }

  const players=Object.entries(roomData.players||{});
  const answers=roomData.answers||{};

  const count=players.filter(([id])=>answers[id]!=null).length;

  $('playerList').textContent=
    '玩家：'+
    (players.map(([,p])=>p.name).join('、')||'尚無');

  let panel=$('answerStatusPanel');

  if(!panel){
    panel=document.createElement('section');
    panel.id='answerStatusPanel';
    $('playerList').after(panel);
  }

  panel.innerHTML=roomData.phase==='asking'?`
    <h3>📊 已作答 ${count}/${players.length} 人</h3>

    <progress
      style="width:100%"
      value="${count}"
      max="${Math.max(players.length,1)}">
    </progress>

    <div style="
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
      gap:8px">

      ${players.map(([id,p])=>`
        <span>
          ${safe(p.name)}：
          ${answers[id]?'🟢 已作答':'⚪ 未作答'}
        </span>
      `).join('')}
    </div>
  `:'';

  const q=roomData.quiz?.[roomData.index];
  const finished=roomData.phase==='finished';

  $('hostGame').innerHTML=`
    <h3>${safe(roomData.quizName||'遊戲房間')}</h3>

    ${q?`
      <h3>
        第 ${roomData.index+1}/${roomData.quiz.length} 題：
        ${safe(q.prompt)}
      </h3>

      <p>
        ${q.options.map((o,i)=>
          `${'ABCD'[i]}. ${safe(o)}`
        ).join('<br>')}
      </p>
    `:''}

    ${roomData.phase==='revealed'?`
      <p>
        ✅ 正確答案：
        ${'ABCD'[q.correctIndex]}
        ${safe(q.options[q.correctIndex])}
      </p>

      <div class="notice">
        ${safe(q.explanation||'本題沒有解析')}
      </div>
    `:''}

    ${finished?`
      <h3>🏆 遊戲結束</h3>
      <button id="hostReview">
        📖 查看完整答題回顧
      </button>
    `:''}

    <h3>排行榜</h3>

    ${[...players]
      .sort((a,b)=>(b[1].score||0)-(a[1].score||0))
      .map(([,p],i)=>
        `${i+1}. ${safe(p.name)} — ${p.score||0} 分`
      ).join('<br>')}
  `;

  if($('hostReview'))$('hostReview').onclick=openReview;

  show('start',roomData.phase==='waiting');
  show('reveal',roomData.phase==='asking');

  show(
    'next',
    roomData.phase==='revealed'&&
    roomData.index+1<roomData.quiz.length
  );

  show(
    'end',
    ['asking','revealed'].includes(roomData.phase)
  );

  clearInterval(hostTimer);

  if(roomData.phase==='asking'){
    hostTimer=setInterval(()=>{
      if(
        roomData?.phase==='asking'&&
        Date.now()>=roomData.endsAt
      ){
        clearInterval(hostTimer);
        reveal();
      }
    },400);
  }
}

async function ask(index){
  try{
    if(!host||!roomData?.quiz?.[index])return;

    await update(ref(db,'rooms/'+room),{
      phase:'asking',
      index,
      endsAt:Date.now()+
        (Number(roomData.quiz[index].timeLimit)||15)*1000,
      answers:null
    });

    beep();
  }catch(e){
    err('開始題目失敗',e);
  }
}

async function reveal(){
  if(!host||roomData?.phase!=='asking')return;

  try{
    if(!roomQuiz){
      const snap=await get(
        ref(db,`quizzes/${user.uid}/roomSnapshots/${room}`)
      );

      if(!snap.exists()){
        throw Error('找不到此房間的答案備份');
      }

      roomQuiz=snap.val();
    }

    const q=roomQuiz.questions[roomData.index];
    const players=roomData.players||{};
    const answers=roomData.answers||{};
    const patch={phase:'revealed'};

    patch[`quiz/${roomData.index}/correctIndex`]=
      Number(q.correctIndex);

    patch[`quiz/${roomData.index}/explanation`]=
      q.explanation||'';

    patch[`history/${roomData.index}`]={
      prompt:q.prompt,
      options:q.options,
      correctIndex:Number(q.correctIndex),
      explanation:q.explanation||'',

      answers:Object.fromEntries(
        Object.entries(answers).map(([id,a])=>[
          id,
          {choice:Number(a.choice)}
        ])
      )
    };

    for(const [id,p] of Object.entries(players)){
      const a=answers[id];

      const right=
        a&&Number(a.choice)===Number(q.correctIndex);

      const bonus=right
        ?Math.max(
          0,
          Math.round(
            500*Math.max(0,roomData.endsAt-a.at)/
            ((Number(q.timeLimit)||15)*1000)
          )
        )
        :0;

      patch[`players/${id}/score`]=
        (p.score||0)+(right?500+bonus:0);
    }

    await update(ref(db,'rooms/'+room),patch);

    beep();
  }catch(e){
    err('公布答案失敗',e);
  }
}

async function join(){
  const code=$('joinCode').value.trim();
  const name=$('nickname').value.trim();

  if(!/^\d{6}$/.test(code)||!name){
    alert('請輸入六位房號與暱稱');
    return;
  }

  joining=true;

  try{
    if(!auth.currentUser||!auth.currentUser.isAnonymous){
      if(auth.currentUser)await signOut(auth);
      await signInAnonymously(auth);
    }

    const snap=await get(ref(db,'rooms/'+code));

    if(!snap.exists())throw Error('找不到房間');

    if(snap.val().phase!=='waiting'){
      throw Error('遊戲已開始');
    }

    playerId=auth.currentUser.uid;

    await set(
      ref(db,`rooms/${code}/players/${playerId}`),
      {name,score:0}
    );

    screen('player');

    $('playerCode').textContent=code;

    listenRoom(code);
    beep();
  }catch(e){
    err('加入失敗',e);
    screen('join');
  }finally{
    joining=false;
  }
}

function renderPlayer(){
  const phase=roomData.phase;
  const i=roomData.index;
  const q=roomData.quiz?.[i];
  const a=roomData.answers?.[playerId];

  $('playerStatus').textContent=
    phase==='waiting'
      ?'等待主持人開始…'
      :phase==='finished'
        ?'遊戲結束'
        :`第 ${i+1}/${roomData.quiz.length} 題`;

  $('ranking').innerHTML=
    Object.values(roomData.players||{})
      .sort((a,b)=>(b.score||0)-(a.score||0))
      .map((p,j)=>
        `${j+1}. ${safe(p.name)} — ${p.score||0} 分`
      ).join('<br>');

  clearInterval(playerTimer);

  if(phase==='waiting'||phase==='finished'||!q){
    $('playerQuestion').innerHTML='';

    $('playerResult').innerHTML=
      phase==='finished'
        ?'<h3>🏆 遊戲結束</h3>'+
         '<button id="playerReview">📖 查看完整答題回顧</button>'
        :'';

    if($('playerReview'))$('playerReview').onclick=openReview;

    return;
  }

  const left=()=>Math.max(
    0,
    Math.ceil((roomData.endsAt-Date.now())/1000)
  );

  $('playerQuestion').innerHTML=`
    <h2>${safe(q.prompt)}</h2>

    <p class="big" id="countdown">
      ${phase==='asking'?left()+' 秒':'已公布答案'}
    </p>

    <div class="options">
      ${q.options.map((o,j)=>`
        <button data-choice="${j}"
          ${a||phase!=='asking'||left()===0?'disabled':''}
          class="${a&&Number(a.choice)===j?'selected':''}">
          ${'ABCD'[j]}. ${safe(o)}
        </button>
      `).join('')}
    </div>
  `;

  $('playerQuestion')
    .querySelectorAll('[data-choice]')
    .forEach(b=>{
      b.onclick=()=>submit(Number(b.dataset.choice));
    });

  $('playerResult').innerHTML=
    phase==='asking'
      ?(a?'<p class="notice">已作答，等待公布答案。</p>':'')
      :`
        <h2 class="${
          a&&Number(a.choice)===Number(q.correctIndex)
            ?'right'
            :'wrong'
        }">
          ${
            !a
              ?'未作答'
              :Number(a.choice)===Number(q.correctIndex)
                ?'答對！'
                :'答錯！'
          }
        </h2>

        <p>
          正確答案：
          ${'ABCD'[Number(q.correctIndex)]}.
          ${safe(q.options[Number(q.correctIndex)])}
        </p>

        <div class="notice">
          ${safe(q.explanation||'本題沒有解析')}
        </div>
      `;

  if(phase==='asking'){
    playerTimer=setInterval(()=>{
      if($('countdown')){
        $('countdown').textContent=left()+' 秒';
      }

      if(left()===0){
        $('playerQuestion')
          .querySelectorAll('[data-choice]')
          .forEach(b=>b.disabled=true);
      }
    },300);
  }
}

async function submit(choice){
  if(
    roomData?.phase!=='asking'||
    Date.now()>=roomData.endsAt
  )return;

  try{
    await runTransaction(
      ref(db,`rooms/${room}/answers/${playerId}`),
      current=>current===null
        ?{choice,at:Date.now()}
        :undefined
    );

    beep();
  }catch(e){
    err('送出失敗',e);
  }
}

function openReview(){
  if(roomData?.phase!=='finished'){
    return alert('遊戲結束後才能回顧');
  }

  if(!Object.keys(roomData.history||{}).length){
    return alert('沒有可用的回顧紀錄');
  }

  reviewIndex=0;

  let overlay=$('quizReviewOverlay');

  if(!overlay){
    overlay=document.createElement('div');
    overlay.id='quizReviewOverlay';

    overlay.style.cssText=
      'position:fixed;inset:0;background:#0009;'+
      'z-index:9999;overflow:auto;padding:14px';

    overlay.innerHTML=`
      <div style="
        max-width:700px;
        margin:20px auto;
        padding:20px;
        background:white;
        border-radius:16px">

        <div class="row">
          <h2>📖 完整答題回顧</h2>
          <button id="reviewClose">關閉 ✕</button>
        </div>

        <div id="reviewContent"></div>

        <div class="row">
          <button id="reviewPrev">← 上一題</button>
          <button id="reviewNext">下一題 →</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    $('reviewClose').onclick=()=>overlay.remove();

    $('reviewPrev').onclick=()=>{
      reviewIndex--;
      renderReview();
    };

    $('reviewNext').onclick=()=>{
      reviewIndex++;
      renderReview();
    };
  }

  renderReview();
}

function renderReview(){
  const keys=Object.keys(roomData.history||{})
    .map(Number)
    .sort((a,b)=>a-b);

  reviewIndex=Math.max(
    0,
    Math.min(keys.length-1,reviewIndex)
  );

  const q=roomData.history[keys[reviewIndex]];
  const answers=q.answers||{};
  const players=roomData.players||{};
  const correct=Number(q.correctIndex);
  const own=answers[playerId];

  $('reviewContent').innerHTML=`
    <p>第 ${reviewIndex+1}/${keys.length} 題</p>

    <h3>${safe(q.prompt)}</h3>

    ${q.options.map((o,i)=>`
      <div style="
        padding:10px;
        margin:7px 0;
        border:1px solid #ddd;
        border-radius:10px">

        ${'ABCD'[i]}. ${safe(o)}

        ${i===correct?'✅ 正確答案':''}

        <br>

        <small>
          選擇此項
          ${Object.values(answers)
            .filter(a=>Number(a.choice)===i).length}
          人
        </small>
      </div>
    `).join('')}

    <div class="notice">
      <b>答案解析</b>
      <p style="white-space:pre-wrap">
        ${safe(q.explanation||'本題沒有解析')}
      </p>
    </div>

    ${host?`
      <h3>所有玩家作答</h3>

      ${Object.entries(players).map(([id,p])=>`
        <p>
          ${safe(p.name)}：
          ${
            answers[id]
              ?'ABCD'[Number(answers[id].choice)]+
                (Number(answers[id].choice)===correct?' ✅':' ❌')
              :'未作答'
          }
        </p>
      `).join('')}
    `:`
      <h3>
        我的答案：
        ${own?'ABCD'[Number(own.choice)]:'未作答'}
        ${
          own
            ?(Number(own.choice)===correct?'✅':'❌')
            :''
        }
      </h3>
    `}
  `;

  $('reviewPrev').disabled=reviewIndex===0;
  $('reviewNext').disabled=reviewIndex===keys.length-1;
}

// 首頁
$('hostEntry').onclick=()=>screen('hostLogin');
$('playerEntry').onclick=()=>screen('join');

$('backLogin').onclick=
$('backJoin').onclick=()=>screen('home');

// 主持人登入
$('login').onclick=async()=>{
  try{
    await signInWithEmailAndPassword(
      auth,
      $('email').value,
      $('password').value
    );
  }catch(e){
    err('登入失敗',e);
  }
};

// 主持人註冊
$('register').onclick=async()=>{
  try{
    await createUserWithEmailAndPassword(
      auth,
      $('email').value,
      $('password').value
    );
  }catch(e){
    err('註冊失敗',e);
  }
};

// 登出
$('logout').onclick=async()=>{
  try{
    if(unsubscribe){
      unsubscribe();
      unsubscribe=null;
    }

    room='';
    roomData=null;

    await signOut(auth);
  }catch(e){
    err('登出失敗',e);
  }
};

// 題庫控制
$('editToggle').onclick=()=>renderLibraries();

$('createRoom').onclick=()=>{
  if(selectedId){
    createRoom(selectedId);
  }else{
    alert('請先從題庫列表選擇一份題庫');
  }
};

// 新增題目
$('addQuestion').onclick=()=>{
  if(!quiz)return;

  syncEditor();

  quiz.questions.push(blankQuestion());
  editorDirty=true;

  renderEditor();
};

// 儲存題庫
$('saveQuiz').onclick=saveQuiz;

// 恢復原始題庫
$('resetQuiz').onclick=async()=>{
  if(!confirm(
    '將目前編輯的內容換成 GitHub 原始題庫？尚未儲存的修改會消失。'
  ))return;

  try{
    const r=await fetch('./quizzes.json',{cache:'no-store'});

    if(!r.ok)throw Error('找不到 quizzes.json');

    const d=await r.json();

    quiz=normalize(Array.isArray(d)?d[0]:d);

    $('quizName').value=quiz.name;
    editorDirty=true;

    renderEditor();
  }catch(e){
    err('讀取原始題庫失敗',e);
  }
};

// 複製邀請連結
$('copyInvite').onclick=async()=>{
  try{
    await navigator.clipboard.writeText($('invite').value);
    alert('邀請連結已複製');
  }catch(e){
    err('複製失敗',e);
  }
};

// 遊戲控制
$('start').onclick=()=>ask(0);
$('reveal').onclick=reveal;
$('next').onclick=()=>ask(roomData.index+1);

$('end').onclick=async()=>{
  try{
    await update(
      ref(db,'rooms/'+room),
      {phase:'finished'}
    );
  }catch(e){
    err('結束失敗',e);
  }
};

// 玩家加入
$('joinBtn').onclick=join;

$('quizName').addEventListener('input',()=>editorDirty=true);

// Firebase 啟動
try{
  const app=initializeApp(firebaseConfig);

  auth=getAuth(app);
  db=getDatabase(app);

  onAuthStateChanged(auth,async u=>{
    user=u;
    host=!!u&&!u.isAnonymous;

    if(joining)return;

    if(inviteCode){
      screen('join');
      $('joinCode').value=inviteCode;
      return;
    }

    if(host){
      screen('host');
      msg('正在讀取題庫…');

      try{
        await loadLibraries();
        msg('已連線');
      }catch(e){
        err('題庫載入失敗',e);
      }
    }else{
      screen('home');
      msg('已連線');
    }
  },e=>err('登入狀態失敗',e));

}catch(e){
  err('Firebase 初始化失敗',e);
}