import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {getAuth,onAuthStateChanged,signInAnonymously,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {getDatabase,ref,set,get,update,onValue,runTransaction} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';
import {firebaseConfig} from './firebase-config.js';

const $ = id => document.getElementById(id);
const show = (id, visible=true) => $(id).classList.toggle('hidden', !visible);
const msg = value => $('status').textContent = value;
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const params = new URLSearchParams(location.search);
const inviteCode = params.get('code');

let app, auth, db, user, host=false, quiz=null, room='', playerId='', roomData=null;
let hostTimer=null, playerTimer=null, roomUnsubscribe=null, lastIndex=-1, lastPhase='', audio=null;
let joining=false;
let reviewIndex=0;

function sound(kind) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
    const osc=audio.createOscillator(), gain=audio.createGain();
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.frequency.value=kind==='right'?760:kind==='wrong'?240:540;
    gain.gain.value=.08;
    osc.start();
    osc.stop(audio.currentTime+.14);
  } catch (e) {
    console.debug('音效不可用',e);
  }
}

function screen(id) {
  for (const x of ['home','hostLogin','host','join','player']) {
    show(x,x===id);
  }
}

function errorMessage(prefix, error) {
  console.error(prefix,error);
  msg(prefix+'：'+(error?.message||String(error)));
  alert(prefix+'：'+(error?.message||String(error)));
}

function boot() {
  try {
    if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.includes('PASTE')) {
      msg('尚未設定 Firebase，請先檢查 firebase-config.js');
      return;
    }

    app=initializeApp(firebaseConfig);
    auth=getAuth(app);
    db=getDatabase(app);

    onAuthStateChanged(auth, async currentUser => {
      user=currentUser;
      host=!!currentUser&&!currentUser.isAnonymous;

      if (joining) return;

      if (inviteCode) {
        screen('join');
        $('joinCode').value=inviteCode;
        msg('已連線');
        return;
      }

      if (host) {
        screen('host');
        msg('正在載入題庫…');
        try {
          await loadQuiz();
          msg('已連線');
        } catch (e) {
          errorMessage('題庫載入失敗',e);
        }
      } else {
        screen('home');
        msg('已連線');
      }
    }, e=>errorMessage('登入狀態檢查失敗',e));

  } catch (e) {
    errorMessage('Firebase 初始化失敗',e);
  }
}

async function loadQuiz() {
  let saved=null;

  try {
    const snapshot=await get(ref(db,'quizzes/'+user.uid));
    if(snapshot.exists()) saved=snapshot.val();
  } catch (e) {
    console.warn('無法讀取雲端題庫，改用 GitHub 備份：',e);
    msg('雲端題庫讀取失敗，正在載入備份…');
  }

  if (!saved) {
    const response=await fetch('./quizzes.json',{cache:'no-store'});
    if (!response.ok) {
      throw new Error('無法載入 quizzes.json（HTTP '+response.status+'）');
    }
    const data=await response.json();
    saved=Array.isArray(data)?data[0]:data;
  }

  if (!saved || typeof saved!=='object') {
    throw new Error('題庫格式不正確');
  }

  quiz={
    ...saved,
    questions:Object.values(saved.questions||{}).map(q=>({
      ...q,
      options:[...(q.options||['','','',''])]
    }))
  };

  $('quizName').value=quiz.name||'我的題庫';
  renderEditor();
}

function syncEditor() {
  if (!quiz) return;

  for (const el of $('questionList').querySelectorAll('input,select,textarea')) {
    const q=quiz.questions[Number(el.dataset.i)];
    if(!q) continue;

    if (el.dataset.opt!==undefined) {
      q.options[Number(el.dataset.opt)]=el.value;
    } else {
      q[el.dataset.k]=['correctIndex','timeLimit'].includes(el.dataset.k)
        ?Number(el.value)
        :el.value;
    }
  }
}

function renderEditor() {
  if (!quiz) return;

  $('questionList').innerHTML=quiz.questions.map((q,i)=>`
    <div class="question-editor">
      <b>第 ${i+1} 題</b>

      <label>題目
        <input data-i="${i}" data-k="prompt" value="${safe(q.prompt)}">
      </label>

      ${(q.options||['','','','']).map((v,j)=>`
        <label>選項 ${'ABCD'[j]||j+1}
          <input data-i="${i}" data-opt="${j}" value="${safe(v)}">
        </label>
      `).join('')}

      <label>正確答案
        <select data-i="${i}" data-k="correctIndex">
          ${[0,1,2,3].map(j=>`
            <option value="${j}" ${Number(q.correctIndex)===j?'selected':''}>
              ${'ABCD'[j]}
            </option>
          `).join('')}
        </select>
      </label>

      <label>答案解析
        <textarea data-i="${i}" data-k="explanation">${safe(q.explanation||'')}</textarea>
      </label>

      <label>時間（秒）
        <input type="number" min="5" max="120"
          data-i="${i}" data-k="timeLimit"
          value="${Number(q.timeLimit)||15}">
      </label>

      <button data-delete="${i}">刪除此題</button>
    </div>
  `).join('');

  $('questionList').querySelectorAll('[data-delete]').forEach(button=>{
    button.onclick=()=>{
      syncEditor();
      if(!confirm('確定刪除這一題？')) return;
      quiz.questions.splice(Number(button.dataset.delete),1);
      renderEditor();
    };
  });
}

function listenRoom(code) {
  if(roomUnsubscribe) roomUnsubscribe();

  room=code;

  roomUnsubscribe=onValue(ref(db,'rooms/'+code),snapshot=>{
    if(!snapshot.exists()) {
      msg('房間不存在或已結束');
      return;
    }

    roomData=snapshot.val();

    if(host) renderHost();
    else renderPlayer();

  },e=>errorMessage('房間連線失敗',e));
}

async function createRoom() {
  try {
    if(!quiz) throw new Error('請先載入題庫');

    syncEditor();

    if(!quiz.questions.length) {
      alert('請先新增題目');
      return;
    }

    let code='';

    for(let i=0;i<15;i++) {
      const candidate=String(Math.floor(100000+Math.random()*900000));

      if(!(await get(ref(db,'rooms/'+candidate))).exists()) {
        code=candidate;
        break;
      }
    }

    if(!code) throw new Error('房號產生失敗，請重試');

    await set(ref(db,'rooms/'+code),{
      hostUid:user.uid,

      quiz:quiz.questions.map(q=>({
        prompt:q.prompt||'',
        options:q.options||['','','',''],
        timeLimit:Number(q.timeLimit)||15
      })),

      phase:'waiting',
      index:-1,
      createdAt:Date.now(),
      players:{},
      answers:{}
    });

    lastIndex=-1;
    show('hostRoom');
    listenRoom(code);

  } catch(e) {
    errorMessage('建立房間失敗',e);
  }
}

function renderHost() {
  if(!roomData) return;

  $('roomCode').textContent=room;
  $('invite').value=new URL('?code='+room,location.href).href;
  $('qr').innerHTML='';

  if(window.QRCode) {
    try {
      window.QRCode.toCanvas(
        $('qr').appendChild(document.createElement('canvas')),
        $('invite').value,
        {width:220,margin:2}
      ).catch(()=>{
        $('qr').textContent='QR Code 產生失敗';
      });
    } catch(e) {
      $('qr').textContent='QR Code 產生失敗';
    }
  } else {
    $('qr').textContent='QR Code 載入失敗，請複製邀請連結';
  }

  const players=Object.entries(roomData.players||{});

  $('playerList').textContent=
    '已加入玩家：'+
    (players.map(([,p])=>p.name).join('、')||'尚無');

  // 主持人即時作答狀態
  const submitted=roomData.answers||{};
  const count=players.filter(([id])=>submitted[id]!=null).length;
  const total=players.length;

  const statusPanel=
    document.getElementById('answerStatusPanel')||
    document.createElement('section');

  statusPanel.id='answerStatusPanel';

  statusPanel.style.cssText=
    'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:12px';

  $('playerList').insertAdjacentElement('afterend',statusPanel);

  statusPanel.innerHTML=roomData.phase==='asking'?`
    <h3>
      📊 即時作答狀態：
      ${count}/${total} 人
      （${total?Math.round(count/total*100):0}%）
    </h3>

    <progress
      value="${count}"
      max="${Math.max(1,total)}"
      style="width:100%">
    </progress>

    <div style="
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
      gap:8px;
      margin-top:10px">

      ${players.map(([id,p])=>`
        <div>
          ${safe(p.name)}：
          ${submitted[id]?'🟢 已作答':'⚪ 尚未作答'}
        </div>
      `).join('')}

    </div>
  `:
  roomData.phase==='waiting'
    ?`<p>目前 ${total} 人已加入，等待開始。</p>`
    :'';

  statusPanel.style.display=
    ['asking','waiting'].includes(roomData.phase)?'block':'none';

  const q=roomData.quiz?.[roomData.index];

  $('hostGame').innerHTML=q?`
    <h3>
      第 ${roomData.index+1}/${roomData.quiz.length} 題：
      ${safe(q.prompt)}
    </h3>

    <p>
      ${(q.options||[]).map((o,i)=>
        `${'ABCD'[i]}. ${safe(o)}`
      ).join('<br>')}
    </p>

    <p>
      ${
        roomData.phase==='asking'
          ?'倒數中'
          :roomData.phase==='revealed'
            ?'正確答案：'+('ABCD'[Number(q.correctIndex)]||'未設定')
            :'遊戲結束'
      }
    </p>

    ${
      roomData.phase==='revealed'&&q.explanation
        ?`<div class="notice">
            <b>答案解析</b>
            <p style="white-space:pre-wrap">${safe(q.explanation)}</p>
          </div>`
        :''
    }

    ${
      roomData.phase==='finished'
        ?'<button type="button" data-open-review>📖 查看完整答題回顧</button>'
        :''
    }

    <h3>排行榜</h3>

    ${
      players
        .sort((a,b)=>(b[1].score||0)-(a[1].score||0))
        .map(([,p],i)=>
          `${i+1}. ${safe(p.name)} — ${p.score||0} 分`
        ).join('<br>')
    }
  `:'';

  if(roomData.phase==='finished' && !q) {
    $('hostGame').innerHTML=
      '<h3>🏆 遊戲結束</h3>'+
      '<button type="button" data-open-review>📖 查看完整答題回顧</button>';
  }

  $('hostGame')
    .querySelector('[data-open-review]')
    ?.addEventListener('click',()=>openReview());

  show('start',roomData.phase==='waiting');
  show('reveal',roomData.phase==='asking');

  show(
    'next',
    roomData.phase==='revealed'&&
    roomData.index+1<roomData.quiz.length
  );

  show(
    'end',
    roomData.phase==='asking'||roomData.phase==='revealed'
  );

  if(roomData.phase==='asking'&&lastIndex!==roomData.index) {
    lastIndex=roomData.index;
    clearInterval(hostTimer);

    hostTimer=setInterval(()=>{
      if(
        roomData?.phase==='asking'&&
        Date.now()>=roomData.endsAt
      ) {
        clearInterval(hostTimer);
        reveal();
      }
    },400);
  }

  if(roomData.phase!=='asking') {
    clearInterval(hostTimer);
  }
}

async function ask(index) {
  try {
    const q=roomData.quiz[index];

    if(!q) throw new Error('找不到題目');

    await update(ref(db,'rooms/'+room),{
      phase:'asking',
      index,
      endsAt:Date.now()+(Number(q.timeLimit)||15)*1000,
      answers:null
    });

    sound('tick');

  } catch(e) {
    errorMessage('開始題目失敗',e);
  }
}

async function reveal() {
  if(!host||roomData?.phase!=='asking') return;

  try {
    syncEditor();

    const q=quiz.questions[roomData.index];
    const players=roomData.players||{};
    const answers=roomData.answers||{};

    if(!q) throw new Error('找不到原始題目');

    const patch={phase:'revealed'};

    // 保存本題紀錄，下一題清除 answers 時不影響回顧
    patch['history/'+roomData.index]={
      prompt:q.prompt||'',
      options:q.options||['','','',''],
      correctIndex:Number(q.correctIndex),
      explanation:q.explanation||'',

      answers:Object.fromEntries(
        Object.entries(answers).map(([id,a])=>[
          id,
          {choice:Number(a.choice)}
        ])
      )
    };

    patch['quiz/'+roomData.index+'/correctIndex']=
      Number(q.correctIndex);

    patch['quiz/'+roomData.index+'/explanation']=
      q.explanation||'';

    for(const [uid,p] of Object.entries(players)) {
      const a=answers[uid];

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

      patch['players/'+uid+'/score']=
        (p.score||0)+(right?500+bonus:0);
    }

    await update(ref(db,'rooms/'+room),patch);
    sound('tick');

  } catch(e) {
    errorMessage('公布答案失敗',e);
  }
}

async function join() {
  const code=$('joinCode').value.trim();
  const name=$('nickname').value.trim();

  if(!/^\d{6}$/.test(code)||!name) {
    alert('請輸入六位數房號與暱稱');
    return;
  }

  joining=true;

  try {
    if(!auth.currentUser||!auth.currentUser.isAnonymous) {
      if(auth.currentUser) await signOut(auth);
      await signInAnonymously(auth);
    }

    const snapshot=await get(ref(db,'rooms/'+code));

    if(!snapshot.exists()) {
      throw new Error('找不到房間');
    }

    if(snapshot.val().phase!=='waiting') {
      throw new Error('遊戲已開始，請等待下一場');
    }

    playerId=auth.currentUser.uid;

    await set(
      ref(db,`rooms/${code}/players/${playerId}`),
      {name,score:0}
    );

    screen('player');
    $('playerCode').textContent=code;

    listenRoom(code);
    sound('tick');
    msg('已加入房間');

  } catch(e) {
    errorMessage('加入房間失敗',e);
    screen('join');
  } finally {
    joining=false;
  }
}

function renderPlayer() {
  if(!roomData) return;

  const phase=roomData.phase;
  const idx=roomData.index;
  const q=roomData.quiz?.[idx];
  const answer=roomData.answers?.[playerId];

  $('playerStatus').textContent=
    phase==='waiting'
      ?'等待主持人開始…'
      :phase==='finished'
        ?'遊戲結束'
        :`第 ${idx+1}/${roomData.quiz.length} 題`;

  $('ranking').innerHTML=
    Object.values(roomData.players||{})
      .sort((a,b)=>(b.score||0)-(a.score||0))
      .map((p,i)=>
        `${i+1}. ${safe(p.name)} — ${p.score||0} 分`
      ).join('<br>');

  if(!q||phase==='waiting'||phase==='finished') {
    $('playerQuestion').innerHTML='';

    $('playerResult').innerHTML=
      phase==='finished'
        ?'<h3>🏆 遊戲結束</h3>'+
         '<button type="button" id="playerReviewButton">'+
         '📖 查看完整答題回顧</button>'
        :'';

    document.getElementById('playerReviewButton')
      ?.addEventListener('click',()=>openReview());

    clearInterval(playerTimer);
    return;
  }

  const key=idx+':'+phase;

  if(lastPhase!==key) {
    lastPhase=key;

    if(phase==='revealed'&&answer) {
      sound(
        Number(answer.choice)===Number(q.correctIndex)
          ?'right'
          :'wrong'
      );
    }
  }

  const left=Math.max(
    0,
    Math.ceil((roomData.endsAt-Date.now())/1000)
  );

  $('playerQuestion').innerHTML=`
    <h2>${safe(q.prompt)}</h2>

    <p class="big" id="countdown">
      ${phase==='asking'?left+' 秒':'已公布答案'}
    </p>

    <div class="options">
      ${(q.options||[]).map((o,i)=>`
        <button
          data-choice="${i}"
          ${answer||phase!=='asking'||left===0?'disabled':''}
          class="${answer&&Number(answer.choice)===i?'selected':''}">
          ${'ABCD'[i]}. ${safe(o)}
        </button>
      `).join('')}
    </div>
  `;

  $('playerQuestion')
    .querySelectorAll('[data-choice]')
    .forEach(button=>{
      button.onclick=()=>submit(Number(button.dataset.choice));
    });

  if(phase==='asking') {
    $('playerResult').innerHTML=answer
      ?'<p class="notice">已送出答案，等待公布結果。</p>'
      :'';
  } else {
    const correct=Number(q.correctIndex);

    const right=
      answer&&Number(answer.choice)===correct;

    $('playerResult').innerHTML=`
      <h2 class="${right?'right':'wrong'}">
        ${
          answer
            ?(right?'答對！':'答錯！')
            :'本題未作答'
        }
      </h2>

      <p>
        <b>正確答案：</b>
        ${'ABCD'[correct]||'未設定'}
        ${q.options?.[correct]?'．'+safe(q.options[correct]):''}
      </p>

      ${
        q.explanation
          ?`<div class="notice">
              <b>答案解析</b>
              <p style="white-space:pre-wrap">${safe(q.explanation)}</p>
            </div>`
          :''
      }
    `;
  }

  clearInterval(playerTimer);

  if(phase==='asking') {
    playerTimer=setInterval(()=>{
      const el=$('countdown');

      if(el) {
        el.textContent=
          Math.max(
            0,
            Math.ceil((roomData.endsAt-Date.now())/1000)
          )+' 秒';
      }
    },300);
  }
}

async function submit(choice) {
  if(
    roomData?.phase!=='asking'||
    Date.now()>=roomData.endsAt
  ) return;

  try {
    await runTransaction(
      ref(db,`rooms/${room}/answers/${playerId}`),
      current=>current===null
        ?{choice,at:Date.now()}
        :undefined
    );

    sound('tick');

  } catch(e) {
    errorMessage('送出答案失敗',e);
  }
}

// 遊戲結束後的完整答題回顧
function openReview() {
  if(roomData?.phase!=='finished') {
    alert('遊戲結束後才能查看完整回顧');
    return;
  }

  const history=roomData.history||{};

  if(!Object.keys(history).length) {
    alert('這場沒有保存答題紀錄；請用更新後的程式建立新房間測試。');
    return;
  }

  reviewIndex=0;

  let overlay=document.getElementById('quizReviewOverlay');

  if(!overlay) {
    overlay=document.createElement('div');
    overlay.id='quizReviewOverlay';

    overlay.style.cssText=
      'position:fixed;inset:0;z-index:9999;'+
      'background:rgba(0,0,0,.65);padding:12px;overflow-y:auto';

    overlay.innerHTML=`
      <div
        role="dialog"
        aria-modal="true"
        aria-label="完整答題回顧"
        style="
          max-width:720px;
          margin:20px auto;
          background:white;
          color:#222;
          border-radius:16px;
          padding:18px;
          box-sizing:border-box">

        <div style="
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:10px">

          <h2>📖 完整答題回顧</h2>

          <button type="button" id="reviewClose">
            關閉 ✕
          </button>
        </div>

        <div id="reviewContent"></div>

        <div style="
          display:flex;
          justify-content:space-between;
          gap:10px;
          margin-top:16px">

          <button type="button" id="reviewPrev">
            ← 上一題
          </button>

          <button type="button" id="reviewNext">
            下一題 →
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('reviewClose').onclick=()=>{
      overlay.remove();
    };

    document.getElementById('reviewPrev').onclick=()=>{
      reviewIndex--;
      renderReview();
    };

    document.getElementById('reviewNext').onclick=()=>{
      reviewIndex++;
      renderReview();
    };
  }

  renderReview();
}

function renderReview() {
  const records=roomData?.history||{};

  const indices=Object.keys(records)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a,b)=>a-b);

  if(!indices.length) return;

  reviewIndex=Math.max(
    0,
    Math.min(reviewIndex,indices.length-1)
  );

  const rec=records[indices[reviewIndex]];
  const answers=rec.answers||{};
  const players=roomData.players||{};
  const correct=Number(rec.correctIndex);
  const options=rec.options||[];

  const counts=options.map((_,i)=>
    Object.values(answers)
      .filter(a=>Number(a.choice)===i)
      .length
  );

  const own=answers[playerId];

  const ownChoice=
    own==null?null:Number(own.choice);

  const mine=host?'':`
    <div class="notice">
      <b>👤 我的作答：</b>

      ${
        ownChoice===null
          ?'未作答'
          :`${'ABCD'[ownChoice]||'?'}．${safe(options[ownChoice]||'')}`
      }

      ${
        ownChoice===null
          ?''
          :ownChoice===correct
            ?'（答對）'
            :'（答錯）'
      }
    </div>
  `;

  const hostDetails=host?`
    <h3>👥 全部玩家作答明細</h3>

    <div style="display:grid;gap:6px">
      ${Object.entries(players).map(([id,p])=>{
        const choice=answers[id]?.choice;

        return `
          <div style="border-bottom:1px solid #ddd;padding:5px">
            ${safe(p.name)}：
            ${
              choice===undefined
                ?'未作答'
                :`${'ABCD'[Number(choice)]||'?'}
                  ${Number(choice)===correct?'✅':'❌'}`
            }
          </div>
        `;
      }).join('')}
    </div>
  `:'';

  document.getElementById('reviewContent').innerHTML=`
    <p>第 ${reviewIndex+1} / ${indices.length} 題</p>

    <h3>${safe(rec.prompt)}</h3>

    <div style="display:grid;gap:8px">
      ${options.map((o,i)=>`
        <div style="
          border:1px solid #ddd;
          border-radius:8px;
          padding:10px">

          ${'ABCD'[i]||i+1}. ${safe(o)}

          ${i===correct?'✅ 正確答案':''}

          <br>

          <small>作答 ${counts[i]} 人</small>
        </div>
      `).join('')}
    </div>

    <p>
      已作答 ${Object.keys(answers).length} /
      ${Object.keys(players).length} 人
    </p>

    <div class="notice">
      <b>📖 答案解析</b>

      <p style="white-space:pre-wrap">
        ${safe(rec.explanation||'本題沒有提供解析')}
      </p>
    </div>

    ${mine}
    ${hostDetails}
  `;

  document.getElementById('reviewPrev').disabled=
    reviewIndex===0;

  document.getElementById('reviewNext').disabled=
    reviewIndex===indices.length-1;
}

// 首頁按鈕
$('hostEntry').onclick=()=>screen('hostLogin');
$('playerEntry').onclick=()=>screen('join');

$('backLogin').onclick=
$('backJoin').onclick=()=>screen('home');

// 主持人登入
$('login').onclick=async()=>{
  try {
    await signInWithEmailAndPassword(
      auth,
      $('email').value,
      $('password').value
    );
  } catch(e) {
    errorMessage('登入失敗',e);
  }
};

// 主持人註冊
$('register').onclick=async()=>{
  try {
    await createUserWithEmailAndPassword(
      auth,
      $('email').value,
      $('password').value
    );
  } catch(e) {
    errorMessage('註冊失敗',e);
  }
};

// 登出
$('logout').onclick=async()=>{
  try {
    await signOut(auth);
  } catch(e) {
    errorMessage('登出失敗',e);
  }
};

// 題庫編輯
$('editToggle').onclick=()=>{
  show('editor',$('editor').classList.contains('hidden'));
};

$('addQuestion').onclick=()=>{
  if(!quiz) return;

  syncEditor();

  quiz.questions.push({
    prompt:'新題目',
    options:['選項 A','選項 B','選項 C','選項 D'],
    correctIndex:0,
    explanation:'',
    timeLimit:15
  });

  renderEditor();
};

// 儲存題庫
$('saveQuiz').onclick=async()=>{
  try {
    if(!quiz||!user||user.isAnonymous) {
      throw new Error('請先登入主持人');
    }

    syncEditor();
    quiz.name=$('quizName').value;

    await set(
      ref(db,'quizzes/'+user.uid),
      quiz
    );

    alert('題庫已儲存');

  } catch(e) {
    errorMessage('儲存題庫失敗',e);
  }
};

// 恢復預設題庫
$('resetQuiz').onclick=async()=>{
  if(!confirm('確定恢復 GitHub 備份題庫？尚未儲存的修改會消失。')) {
    return;
  }

  try {
    const response=await fetch('./quizzes.json',{cache:'no-store'});

    if(!response.ok) throw new Error('讀取失敗');

    const data=await response.json();
    const original=Array.isArray(data)?data[0]:data;

    quiz={
      ...original,
      questions:Object.values(original.questions||{})
    };

    $('quizName').value=quiz.name||'我的題庫';
    renderEditor();

  } catch(e) {
    errorMessage('恢復備份失敗',e);
  }
};

// 建立房間
$('createRoom').onclick=createRoom;

// 複製邀請連結
$('copyInvite').onclick=async()=>{
  try {
    await navigator.clipboard.writeText($('invite').value);
    alert('連結已複製');
  } catch(e) {
    errorMessage('複製失敗，請長按網址手動複製',e);
  }
};

// 開始遊戲
$('start').onclick=()=>ask(0);

// 公布答案
$('reveal').onclick=reveal;

// 下一題
$('next').onclick=()=>ask(roomData.index+1);

// 結束遊戲
$('end').onclick=async()=>{
  try {
    await update(
      ref(db,'rooms/'+room),
      {phase:'finished'}
    );
  } catch(e) {
    errorMessage('結束遊戲失敗',e);
  }
};

// 玩家加入
$('joinBtn').onclick=join;

// 啟動程式
boot();
