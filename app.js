import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {getAuth,onAuthStateChanged,signInAnonymously,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {getDatabase,ref,set,get,update,onValue,remove,runTransaction} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';
import {firebaseConfig} from './firebase-config.js';
const $=id=>document.getElementById(id), show=(id,v=true)=>$(id).classList.toggle('hidden',!v), msg=s=>$('status').textContent=s;
let app,auth,db,user,host=false,quiz,room='',playerId='',roomData=null,timer=null,lastPhase='',lastIndex=-1,audio=null;
const params=new URLSearchParams(location.search), inviteCode=params.get('code');
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sound(kind){try{audio??=new (window.AudioContext||window.webkitAudioContext)();audio.resume();let osc=audio.createOscillator(),g=audio.createGain();osc.connect(g);g.connect(audio.destination);osc.frequency.value=kind==='right'?760:kind==='wrong'?240:540;g.gain.value=.08;osc.start();osc.stop(audio.currentTime+.14)}catch{}}
function screen(id){for(const x of ['home','hostLogin','host','join','player'])show(x,x===id)}
async function boot() {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getDatabase(app);

    onAuthStateChanged(auth, async (u) => {
      user = u;
      host = !!u && !u.isAnonymous;

      msg('已連線');

      if (inviteCode) {
        screen('join');
        $('joinCode').value = inviteCode;
        return;
      }

      if (host) {
        screen('host');
        await loadQuiz();
      } else {
        screen('home');
      }
    }, (error) => {
      msg('登入狀態檢查失敗：' + error.message);
    });

  } catch (error) {
    console.error(error);
    msg('Firebase 連線失敗：' + error.message);
  }
}                   
async function loadQuiz(){ 
  try {
    const snapshot = await get(ref(db, 'quizzes/' + user.uid));

    if (snapshot.exists()) {
      quiz = snapshot.val();
    } else {
      const response = await fetch('./quizzes.json');
      const data = await response.json();
      quiz = data[0];
    }

    quiz.questions = Object.values(quiz.questions || []);

    $('quizName').value = quiz.name || '我的題庫';

    renderEditor();

  } catch (error) {
    console.error('讀取題庫失敗：', error);
    alert('讀取題庫失敗：' + error.message);
  }
}
function renderEditor() {
  $('questionList').innerHTML = quiz.questions.map((q, i) => `
    <div class="question-editor">
      <b>第 ${i + 1} 題</b>

      <label>題目
        <input data-i="${i}" data-k="prompt" value="${safe(q.prompt)}">
      </label>

      ${(q.options || ['', '', '', '']).map((v, j) => `
        <label>選項 ${'ABCD'[j]}
          <input data-i="${i}" data-opt="${j}" value="${safe(v)}">
        </label>
      `).join('')}

      <label>正確答案
        <select data-i="${i}" data-k="correctIndex">
          ${[0, 1, 2, 3].map(j => `
            <option value="${j}" ${Number(q.correctIndex) === j ? 'selected' : ''}>
              ${'ABCD'[j]}
            </option>
          `).join('')}
        </select>
      </label>

      <label>答案解析
        <textarea data-i="${i}" data-k="explanation">${safe(q.explanation || '')}</textarea>
      </label>

      <label>時間（秒）
        <input type="number" min="5" max="120"
          data-i="${i}" data-k="timeLimit"
          value="${q.timeLimit || 15}">
      </label>

      <button data-delete="${i}">刪除此題</button>
    </div>
  `).join('');

  $('questionList').querySelectorAll('input,select,textarea').forEach(el => {
    el.addEventListener('change', () => {
      let q = quiz.questions[+el.dataset.i];

      if (el.dataset.opt !== undefined) {
        q.options[+el.dataset.opt] = el.value;
      } else {
        q[el.dataset.k] =
          ['correctIndex', 'timeLimit'].includes(el.dataset.k)
            ? +el.value
            : el.value;
      }
    });
  });

  $('questionList').querySelectorAll('[data-delete]').forEach(el => {
    el.onclick = () => {
      quiz.questions.splice(+el.dataset.delete, 1);
      renderEditor();
    };
  });
}
function listenRoom(code){room=code;onValue(ref(db,'rooms/'+code),snap=>{if(!snap.exists()){msg('房間不存在或已結束');return}roomData=snap.val();if(host)renderHost();else renderPlayer()})}
async function createRoom(){if(!quiz.questions.length){alert('請先新增題目');return}let code;for(let i=0;i<15;i++){code=String(Math.floor(100000+Math.random()*900000));if(!(await get(ref(db,'rooms/'+code))).exists())break}await set(ref(db,'rooms/'+code),{hostUid:user.uid,quiz:quiz.questions.map(q=>({prompt:q.prompt,options:q.options,timeLimit:q.timeLimit||15,})),phase:'waiting',index:-1,createdAt:Date.now(),players:{},answers:{}});show('hostRoom');listenRoom(code)}
function renderHost(){if(!roomData)return;$('roomCode').textContent=room;$('invite').value=new URL('?code='+room,location.href).href;$('qr').innerHTML='';if(window.QRCode)window.QRCode.toCanvas($('qr').appendChild(document.createElement('canvas')),$('invite').value,{width:220,margin:2});else $('qr').textContent='QR Code 載入失敗，請檢查網路';let players=Object.entries(roomData.players||{});$('playerList').textContent='已加入玩家：'+(players.map(([,p])=>p.name).join('、')||'尚無');let q=roomData.quiz?.[roomData.index];$('hostGame').innerHTML=q?`<h3>第 ${roomData.index+1}/${roomData.quiz.length} 題：${safe(q.prompt)}</h3><p>${q.options.map((o,i)=>`${'ABCD'[i]}. ${safe(o)}`).join('<br>')}</p><p>${roomData.phase==='asking'?'倒數中':roomData.phase==='revealed'?'正確答案：'+ 'ABCD'[quiz.questions[roomData.index].correctIndex]:'遊戲結束'}</p><h3>排行榜</h3>${players.sort((a,b)=>(b[1].score||0)-(a[1].score||0)).map(([,p],i)=>`${i+1}. ${safe(p.name)} — ${p.score||0} 分`).join('<br>')}`:'';show('start',roomData.phase==='waiting');show('reveal',roomData.phase==='asking');show('next',roomData.phase==='revealed'&&roomData.index+1<roomData.quiz.length);show('end',roomData.phase==='asking'||roomData.phase==='revealed');if(roomData.phase==='asking'&&lastIndex!==roomData.index){lastIndex=roomData.index;clearInterval(timer);timer=setInterval(()=>{if(roomData?.phase==='asking'&&Date.now()>=roomData.endsAt){clearInterval(timer);reveal()}},400)} }
async function ask(index){const q=roomData.quiz[index];await update(ref(db,'rooms/'+room),{phase:'asking',index,endsAt:Date.now()+Number(q.timeLimit||15)*1000,answers:null});sound('tick')}
async function reveal(){if(!host||roomData?.phase!=='asking')return;let q=quiz.questions[roomData.index],players=roomData.players||{},answers=roomData.answers||{};let patch={phase:'revealed'};patch['quiz/'+roomData.index+'/correctIndex']=Number(q.correctIndex);for(const [uid,p] of Object.entries(players)){let a=answers[uid];let right=a&&+a.choice===+q.correctIndex;let bonus=right?Math.max(0,Math.round(500*(Math.max(0,roomData.endsAt-a.at)/(q.timeLimit*1000)))):0;patch['players/'+uid+'/score']=(p.score||0)+(right?500+bonus:0)}await update(ref(db,'rooms/'+room),patch);sound('tick')}
async function join(){let code=$('joinCode').value.trim(),name=$('nickname').value.trim();if(!/^\d{6}$/.test(code)||!name){alert('請輸入六位數房號與暱稱');return}if(!user||!user.isAnonymous){await signOut(auth);await signInAnonymously(auth)}let s=await get(ref(db,'rooms/'+code));if(!s.exists()){alert('找不到房間');return}if(s.val().phase!=='waiting'){alert('遊戲已開始，請等待下一場');return}playerId=auth.currentUser.uid;sessionStorage.setItem('quizName',name);await set(ref(db,`rooms/${code}/players/${playerId}`),{name,score:0});screen('player');$('playerCode').textContent=code;listenRoom(code);sound('tick')}
function renderPlayer(){if(!roomData)return;let phase=roomData.phase,idx=roomData.index,q=roomData.quiz?.[idx],answer=roomData.answers?.[playerId];$('playerStatus').textContent=phase==='waiting'?'等待主持人開始…':phase==='finished'?'遊戲結束':`第 ${idx+1}/${roomData.quiz.length} 題`;$('ranking').innerHTML=Object.values(roomData.players||{}).sort((a,b)=>(b.score||0)-(a.score||0)).map((p,i)=>`${i+1}. ${safe(p.name)} — ${p.score||0} 分`).join('<br>');if(!q||phase==='waiting'||phase==='finished'){$('playerQuestion').innerHTML='';$('playerResult').innerHTML='';return}let key=idx+':'+phase;if(lastPhase!==key){lastPhase=key;if(phase==='revealed'&&answer)sound(+answer.choice===+q.correctIndex?'right':'wrong')};let left=Math.max(0,Math.ceil((roomData.endsAt-Date.now())/1000));$('playerQuestion').innerHTML=`<h2>${safe(q.prompt)}</h2><p class="big" id="countdown">${phase==='asking'?left+' 秒':'已公布答案'}</p><div class="options">${q.options.map((o,i)=>`<button data-choice="${i}" ${answer||phase!=='asking'||left===0?'disabled':''} class="${answer&&+answer.choice===i?'selected':''}">${'ABCD'[i]}. ${safe(o)}</button>`).join('')}</div>`;$('playerQuestion').querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>submit(+b.dataset.choice));$('playerResult').innerHTML=phase==='asking'?(answer?'<p class="notice">已送出答案，等待公布結果。</p>':''):answer?`<h2 class="${+answer.choice===+q.correctIndex?'right':'wrong'}">${+answer.choice===+q.correctIndex?'答對！':'答錯！'}</h2>`:'<p>本題未作答</p>';clearInterval(timer);if(phase==='asking')timer=setInterval(()=>{let el=$('countdown');if(el)el.textContent=Math.max(0,Math.ceil((roomData.endsAt-Date.now())/1000))+' 秒'},300)}
async function submit(choice){if(roomData.phase!=='asking'||Date.now()>=roomData.endsAt)return;await runTransaction(ref(db,`rooms/${room}/answers/${playerId}`),current=>current===null?{choice,at:Date.now()}:undefined);sound('tick')}
$('hostEntry').onclick=()=>screen('hostLogin');$('playerEntry').onclick=()=>screen('join');$('backLogin').onclick=$('backJoin').onclick=()=>screen('home');$('login').onclick=async()=>{try{await signInWithEmailAndPassword(auth,$('email').value,$('password').value)}catch(e){alert('登入失敗：'+e.message)}};$('register').onclick=async()=>{try{await createUserWithEmailAndPassword(auth,$('email').value,$('password').value)}catch(e){alert('註冊失敗：'+e.message)}};$('logout').onclick=()=>signOut(auth);$('editToggle').onclick=()=>show('editor',$('editor').classList.contains('hidden'));$('addQuestion').onclick=()=>{quiz.questions.push({prompt:'新題目',options:['選項 A','選項 B','選項 C','選項 D'],correctIndex:0,timeLimit:15});renderEditor()};$('saveQuiz').onclick=async()=>{quiz.name=$('quizName').value;await set(ref(db,'quizzes/'+user.uid),quiz);alert('題庫已儲存')};$('resetQuiz').onclick=async()=>{if(confirm('確定恢復原始題庫？尚未儲存的修改會消失。')){quiz=(await (await fetch('./quizzes.json')).json())[0];renderEditor()}};$('createRoom').onclick=createRoom;$('copyInvite').onclick=async()=>{await navigator.clipboard.writeText($('invite').value);alert('連結已複製')};$('start').onclick=()=>ask(0);$('reveal').onclick=reveal;$('next').onclick=()=>ask(roomData.index+1);$('end').onclick=()=>update(ref(db,'rooms/'+room),{phase:'finished'});$('joinBtn').onclick=join;
boot();
