(() => {
  "use strict";
  const el = id => document.getElementById(id);
  const startScreen = el("startScreen"), errorScreen = el("errorScreen"), errorText = el("errorText");
  const pauseBtn = el("pauseBtn"), restartBtn = el("restartBtn"), pausedBadge = el("pausedBadge");
  const startBtn = el("startBtn");
  // Bind the primary action immediately. Keep a direct, idempotent start handler
  // so later quiz UI initialization cannot accidentally leave the title screen inert.
  if (startBtn) startBtn.addEventListener("click", begin);
  const controls = { left:false, right:false, jump:false };
  const physicalKeys = new Set();
  let game, sceneRef, started = false, paused = false, quizOpen = false, gameOver = false, levelComplete = false, heldPointers = new Map();
  // Declare speech-recognition state at startup to avoid temporal-dead-zone errors.
  let speechRecognition = null;
  let speechAttempts = 0;
  const MAX_SPEECH_ATTEMPTS = 3; // first attempt plus two retries
  let speechFallbackShown = false;
  // Initialize shared quiz state before any Phaser scene can access it.
  let activeChallenge = 0;
  const assetBase = "assets/";

  // Stage 9.2 audio: local Kenney SFX, lazy-unlocked by the first user gesture.
  const soundFiles = { coin:"sfx_coin.ogg", gem:"sfx_gem.ogg", select:"sfx_select.ogg", hurt:"sfx_hurt.ogg", jump:"sfx_jump.ogg", jumpHigh:"sfx_jump-high.ogg", disappear:"sfx_disappear.ogg", throw:"sfx_throw.ogg", magic:"sfx_magic.ogg", bump:"sfx_bump.ogg" };
  let soundEnabled = true, soundVolume = 0.55, audioUnlocked = false;
  const soundPool = {};
  Object.entries(soundFiles).forEach(([key,file]) => {
    soundPool[key] = new Audio(assetBase + "audio/" + file);
    soundPool[key].preload = "auto"; soundPool[key].volume = soundVolume;
  });
  function unlockAudio(){
    if(audioUnlocked) return; audioUnlocked = true;
    const audio = soundPool.select; if(audio){ const old=audio.volume; audio.volume=0; audio.play().then(()=>{audio.pause();audio.currentTime=0;audio.volume=old;}).catch(()=>{audio.volume=old;}); }
  }
  function playSound(key){
    if(!soundEnabled || soundVolume<=0 || !soundPool[key]) return;
    unlockAudio(); const base=soundPool[key];
    try { const a=base.cloneNode(); a.volume=soundVolume; a.play().catch(()=>{}); } catch(_) {}
  }
  const muteBtn = el("muteBtn"), volumeSlider = el("volumeSlider");
  function refreshSoundUi(){
    if(muteBtn){muteBtn.textContent=soundEnabled?"🔊 Sound":"🔇 Muted";muteBtn.setAttribute("aria-pressed",String(!soundEnabled));muteBtn.title=soundEnabled?"Mute sound":"Enable sound";}
    if(volumeSlider) volumeSlider.value=String(Math.round(soundVolume*100));
  }
  muteBtn?.addEventListener("click",()=>{unlockAudio();soundEnabled=!soundEnabled;refreshSoundUi();if(soundEnabled)playSound("select");});
  volumeSlider?.addEventListener("input",()=>{soundVolume=Number(volumeSlider.value)/100;if(soundVolume>0)soundEnabled=true;refreshSoundUi();});
  ["pointerdown","keydown","touchstart"].forEach(evt=>document.addEventListener(evt,unlockAudio,{once:true,passive:true}));
  refreshSoundUi();

  let recovering = false, restartInProgress = false;
  const uiTimers = new Set();
  function scheduleUiCleanup(callback, delay) {
    const timer = window.setTimeout(() => { uiTimers.delete(timer); callback(); }, delay);
    uiTimers.add(timer);
    return timer;
  }
  function clearUiTimers() { uiTimers.forEach(timer => window.clearTimeout(timer)); uiTimers.clear(); }
  function showError(message) {
    errorText.textContent = message || "The game encountered a problem. Try Recover Game.";
    errorScreen.hidden = false;
    startScreen.hidden = true;
  }
  function reportRuntimeError(message) {
    // Surface a useful message instead of leaving a frozen-looking canvas with no explanation.
    showError("A game error occurred: " + String(message || "Unknown error") + ". Choose Recover Game to restart this attempt.");
    clearInputs();
    try { if (sceneRef?.sys?.isActive?.() && sceneRef?.physics?.world?.pause) sceneRef.physics.world.pause(); } catch (_) {}
    paused = true;
    pauseBtn.disabled = true;
  }
  window.addEventListener("error", event => {
    if (started && !recovering) reportRuntimeError(event.message || "Unexpected browser error");
  });
  window.addEventListener("unhandledrejection", event => {
    if (started && !recovering) reportRuntimeError(event.reason?.message || event.reason || "Unexpected asynchronous error");
  });
  function clearInputs() {
    Object.keys(controls).forEach(k => controls[k] = false);
    physicalKeys.clear();
    heldPointers.clear();
    document.querySelectorAll(".touch-btn").forEach(b => b.classList.remove("active"));
    if (sceneRef) {
      sceneRef.clearJumpRequest();
      // Phaser keeps its own keyboard state in addition to the browser-level state.
      // Reset both so a missed keyup cannot leave movement stuck on.
      if (sceneRef.input?.keyboard) {
        sceneRef.input.keyboard.resetKeys();
        sceneRef.input.keyboard.enabled = true;
      }
    }
  }

  function resetSceneInput(scene = sceneRef) {
    physicalKeys.clear();
    Object.keys(controls).forEach(k => controls[k] = false);
    heldPointers.clear();
    document.querySelectorAll(".touch-btn").forEach(b => b.classList.remove("active"));
    if (scene) {
      scene.clearJumpRequest();
      if (scene.keys) Object.values(scene.keys).forEach(key => {
        if (key) { key.isDown = false; key._justDown = false; key._justUp = false; }
      });
      if (scene.input?.keyboard) scene.input.keyboard.resetKeys();
      if (scene.player?.body) scene.player.setVelocityX(0);
    }
  }

  class GameScene extends Phaser.Scene {
    constructor(){ super("GameScene"); this.jumpWasDown=false; this.jumpRequest=false; this.facing=1; this.hasJumped=false; this.quizTriggered=false; this.lives=3; this.quizScore=0; this.quizWrongAttempts=Array(8).fill(0); this.quizCompleted=Array(8).fill(false); this.deathInProgress=false; this.checkpointActive=false; this.invulnerable=false; this.invulnerabilityRemaining=0; this.levelComplete=false; }
    preload(){
      this.load.on("loaderror", file => showError("Could not load asset: " + file.key + " (" + file.src + "). Check that the ZIP was extracted without changing the folder structure."));
      this.load.svg("idle", assetBase+"characters/character_yellow_idle.svg", {width:128,height:128});
      this.load.svg("walkA", assetBase+"characters/character_yellow_walk_a.svg", {width:128,height:128});
      this.load.svg("walkB", assetBase+"characters/character_yellow_walk_b.svg", {width:128,height:128});
      this.load.svg("jump", assetBase+"characters/character_yellow_jump.svg", {width:128,height:128});
      this.load.svg("hills", assetBase+"backgrounds/background_color_hills.svg", {width:256,height:256});
      this.load.svg("grass", assetBase+"tiles/terrain_grass_block.svg", {width:64,height:64});
      this.load.svg("grassTop", assetBase+"tiles/terrain_grass_block_top.svg", {width:64,height:64});
      this.load.svg("goldCoin", assetBase+"collectibles/coin_gold.svg", {width:64,height:64});
    }
    create(){
      sceneRef=this;
      restartInProgress = false;
      recovering = false;
      // Phaser Scene.restart() reuses this Scene instance; constructor() does NOT run again.
      // Reset every per-attempt value here so Game Over -> Restart matches a fresh page load.
      this.lives = 3;
      this.quizScore = 0;
      this.quizWrongAttempts = Array(8).fill(0);
      this.quizCompleted = Array(8).fill(false);
      this.deathInProgress = false;
      this.checkpointActive = false;
      this.invulnerable = false;
      this.invulnerabilityRemaining = 0;
      this.levelComplete = false;
      this.jumpWasDown = false;
      this.jumpRequest = false;
      this.facing = 1;
      this.hasJumped = false;
      this.quizTriggered = false;
      this.challengeIndex = 0;
      this.challengeQuizActive = false;
      this.score = 0;
      gameOver = false;
      paused = false;
      quizOpen = false;
      levelComplete = false;
      activeChallenge = 0;
      clearInputs();
      resetSceneInput(this);
      const w=3400,h=540; this.physics.world.setBounds(0,0,w,h);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        // Scene shutdown already stops its systems; do not call pause() on a world
        // while Phaser is tearing it down. Clear external references and stale input.
        try { this.tweens?.killAll(); } catch (_) {}
        resetSceneInput(this);
        if (sceneRef === this) sceneRef = null;
      });
      this.add.tileSprite(w/2,h/2,w,h,"hills").setScrollFactor(0).setTint(0xffffff);
      // Soft sky wash keeps the level readable over the supplied scenery.
      this.add.rectangle(w/2, h-42, w, 84, 0x83d6e8).setDepth(0);
      const platforms=this.physics.add.staticGroup();
      const addPlatform=(x,y,tiles)=>{ for(let i=0;i<tiles;i++){ const key=(i===0||i===tiles-1)?"grassTop":"grass"; const obj=platforms.create(x+i*64,y,key); obj.setOrigin(0.5,0.5); obj.refreshBody(); } };
      addPlatform(96,490,21);
      // A clearly marked pit after the existing challenge route; the gap can be jumped over.
      this.add.rectangle(1488,518,192,42,0x233848).setStrokeStyle(3,0x142533).setDepth(1);
      this.add.text(1488,500,"PIT",{fontFamily:"system-ui, sans-serif",fontSize:"18px",fontStyle:"bold",color:"#ffffff",stroke:"#142533",strokeThickness:4}).setOrigin(0.5).setDepth(2);
      addPlatform(1632,490,3);
      // Stage 9: extended trail into two new worlds. Keep the existing start zone unchanged.
      addPlatform(1824,490,25);
      // New world landmarks and elevated routes.
      this.add.rectangle(2240,270,760,540,0x9bd8c8,0.22).setDepth(0);
      this.add.rectangle(2960,270,680,540,0xe0c7f7,0.22).setDepth(0);
      const worldSign=(x,y,title,subtitle,color)=>{
        this.add.rectangle(x,y,170,54,color).setStrokeStyle(3,0xffffff).setDepth(2);
        this.add.text(x,y-8,title,{fontFamily:"system-ui, sans-serif",fontSize:"16px",fontStyle:"bold",color:"#17384b"}).setOrigin(0.5).setDepth(3);
        this.add.text(x,y+13,subtitle,{fontFamily:"system-ui, sans-serif",fontSize:"10px",fontStyle:"bold",color:"#17384b"}).setOrigin(0.5).setDepth(3);
      };
      worldSign(2070,350,"MYSTERY CAVE","WORLD 2",0x7ed5b6);
      worldSign(2790,350,"SKY TEMPLE","WORLD 3",0xd5b4f4);
      addPlatform(1950,390,3); addPlatform(2200,330,3); addPlatform(2440,390,3);
      addPlatform(2640,330,3); addPlatform(2870,390,3); addPlatform(3100,330,3);
      addPlatform(340,390,3); addPlatform(630,315,3);
      this.player=this.physics.add.sprite(100,420,"idle"); this.player.setDisplaySize(62,62); this.player.setCollideWorldBounds(false); this.player.body.setSize(48,54).setOffset(40,42); this.player.setDepth(3); this.player.setBounce(0); this.player.setMaxVelocity(250,800);
      this.physics.add.collider(this.player,platforms);
      // Stage 3: a small patrol enemy on the safe opening platform.
      this.enemyDirection=1;
      this.enemyPatrol={left:250,right:340,speed:72};
      this.enemy=this.add.ellipse(280,438,42,34,0x53b85a).setStrokeStyle(3,0x236b35).setDepth(3);
      this.enemyEyes=[
        this.add.ellipse(271,433,5,7,0xffffff).setDepth(4),
        this.add.ellipse(289,433,5,7,0xffffff).setDepth(4),
        this.add.circle(272,434,2,0x183d25).setDepth(5),
        this.add.circle(290,434,2,0x183d25).setDepth(5)
      ];
      this.physics.add.existing(this.enemy);
      this.enemy.body.setAllowGravity(false);
      this.enemy.body.setImmovable(true);
      this.enemy.body.setSize(38,28);
      this.physics.add.overlap(this.player,this.enemy,()=>this.handleEnemyHit());
      // World 2 enemy: a purple cave bat with flapping wings and a separate patrol path.
      this.caveBatDirection=1;
      this.caveBatPatrol={left:2240,right:2370,speed:88};
      this.caveBat=this.add.container(2300,350).setDepth(4);
      this.caveBatWingL=this.add.triangle(-18,0,-16,-5,8,-14,4,9,0x7048b8).setStrokeStyle(2,0x38216d);
      this.caveBatWingR=this.add.triangle(18,0,16,-5,-8,-14,-4,9,0x7048b8).setStrokeStyle(2,0x38216d);
      this.caveBatBody=this.add.ellipse(0,0,27,31,0x9a73e6).setStrokeStyle(2,0x38216d);
      this.caveBatEyeL=this.add.circle(-5,-3,3,0xfff4a8);
      this.caveBatEyeR=this.add.circle(5,-3,3,0xfff4a8);
      this.caveBatMouth=this.add.triangle(0,6,0,-2,5,4,-5,4,0x39214f);
      // IMPORTANT: attach all separately-created shapes to the container.
      // Without this, the bat parts remain at local coordinates near the world origin and the enemy appears invisible.
      this.caveBat.add([this.caveBatWingL,this.caveBatWingR,this.caveBatBody,this.caveBatEyeL,this.caveBatEyeR,this.caveBatMouth]);
      this.physics.add.existing(this.caveBat);
      this.caveBat.body.setAllowGravity(false); this.caveBat.body.setImmovable(true);
      this.caveBat.body.setSize(35,28);
      this.physics.add.overlap(this.player,this.caveBat,()=>this.handleEnemyHit());
      this.shieldRing=this.add.ellipse(this.player.x,this.player.y,78,78,0x46b9ff,0.12).setStrokeStyle(3,0x46b9ff).setDepth(5).setVisible(false);
      this.startPosition={x:100,y:420};
      this.respawnPosition={x:this.startPosition.x,y:this.startPosition.y};
      this.checkpointActive=false;
      // Stage 2: a visual flag checkpoint on the safe platform beyond the pit.
      // The flag has no collision body; activation is handled by the grounded player proximity check.
      this.checkpointX=1696;
      this.checkpointPole=this.add.rectangle(this.checkpointX-8,434,5,48,0x6b4a2b).setDepth(3);
      this.checkpointFlag=this.add.triangle(this.checkpointX+12,411,-20,-12,20,-4,-20,8,0xf05a47).setDepth(4);
      this.checkpointLabel=this.add.text(this.checkpointX,386,"CHECKPOINT",{fontFamily:"system-ui, sans-serif",fontSize:"11px",fontStyle:"bold",color:"#8b2b27",stroke:"#ffffff",strokeThickness:3}).setOrigin(0.5).setDepth(4);
      // Stage 5: a clear finish gate at the end of the trail. It only completes after all four quizzes.
      this.finishGateX=3300;
      this.finishGate=this.add.rectangle(this.finishGateX,425,20,130,0x2c8a62).setStrokeStyle(4,0x14563b).setDepth(2);
      this.finishBanner=this.add.rectangle(this.finishGateX,365,118,32,0xffd65a).setStrokeStyle(3,0x9a7625).setDepth(3);
      this.finishLabel=this.add.text(this.finishGateX,365,"FINISH",{fontFamily:"system-ui, sans-serif",fontSize:"17px",fontStyle:"bold",color:"#183a4a"}).setOrigin(0.5).setDepth(4);
      this.finishStatus=this.add.text(this.finishGateX,326,"8 QUIZZES TO CLEAR",{fontFamily:"system-ui, sans-serif",fontSize:"10px",fontStyle:"bold",color:"#17425b",stroke:"#ffffff",strokeThickness:3}).setOrigin(0.5).setDepth(4);
      // Stage 4/5: visible obstacles for OVER, UNDER, THROUGH and AROUND.
      const addSolid = (x,y,width,height,color=0xb77942,stroke=0x69401f) => {
        const obj=this.add.rectangle(x,y,width,height,color).setStrokeStyle(3,stroke).setDepth(2);
        this.physics.add.existing(obj,true); this.physics.add.collider(this.player,obj); return obj;
      };
      this.crate = addSolid(520,440,36,36);
      // UNDER: a raised beam with enough headroom for the player to walk beneath it.
      addSolid(790,390,150,18,0x7c9b55,0x38532a);
      addSolid(710,425,18,58,0x7c9b55,0x38532a);
      addSolid(870,425,18,58,0x7c9b55,0x38532a);
      // THROUGH: a small open tunnel. Side supports and roof define a clear passage.
      addSolid(1030,382,132,18,0x8b9fb0,0x40596c);
      addSolid(959,427,18,64,0x8b9fb0,0x40596c);
      addSolid(1101,427,18,64,0x8b9fb0,0x40596c);
      // AROUND: a rock with a marked upper route; the raised route encourages a detour around it.
      this.rock = this.add.ellipse(1265,454,64,48,0x77828a).setStrokeStyle(3,0x424e58).setDepth(2);
      addSolid(1265,475,64,22,0x77828a,0x424e58);
      addSolid(1210,410,70,14,0x6eae65,0x2f7444);
      addSolid(1320,410,70,14,0x6eae65,0x2f7444);
      // Stage 3: collectable gold coins placed along the training route.
      this.score = 0;
      this.coins = this.physics.add.staticGroup();
      const coinPositions = [
        [220, 420], [350, 325], [570, 420], [650, 420], [790, 345], [900, 420],
        [1030, 340], [1160, 420], [1325, 365], [1870, 420], [2020, 355], [2200, 290],
        [2390, 420], [2520, 350], [2700, 290], [2890, 420], [3040, 290], [3210, 420]
      ];
      this.coinPositions=coinPositions;
      coinPositions.forEach(([x,y]) => {
        const coin = this.coins.create(x, y, "goldCoin");
        coin.spawnX=x; coin.spawnY=y;
        coin.setDisplaySize(32, 32);
        coin.refreshBody();
        coin.setDepth(2);
      });
      this.physics.add.overlap(this.player, this.coins, (player, coin) => {
        if (!coin.active) return;
        coin.disableBody(true, true);
        this.score += 1;
        playSound("coin");
        this.scoreText.setText(`COINS: ${this.score} / ${coinPositions.length}`);
        this.collectText.setText("+1 COIN! ✦").setAlpha(1).setY(76).setScale(0.9);
        this.tweens.killTweensOf(this.collectText);
        this.tweens.add({targets:this.collectText, alpha:0, y:52, scale:1.12, duration:850, ease:"Back.easeOut"});
        const sparkle=this.add.text(player.x,player.y-24,"✦ +1",{fontFamily:"system-ui, sans-serif",fontSize:"17px",fontStyle:"bold",color:"#f2b800",stroke:"#ffffff",strokeThickness:4}).setOrigin(0.5).setDepth(15);
        this.tweens.add({targets:sparkle,y:sparkle.y-34,alpha:0,scale:1.25,duration:700,onComplete:()=>sparkle.destroy()});
      });
      this.cameras.main.setBounds(0,0,w,h); this.cameras.main.startFollow(this.player,true,0.08,0.08); this.cameras.main.setZoom(1);
      this.anims.create({key:"walk",frames:[{key:"walkA"},{key:"walkB"}],frameRate:7,repeat:-1});
      this.keys=this.input.keyboard.addKeys({left:Phaser.Input.Keyboard.KeyCodes.LEFT,a:Phaser.Input.Keyboard.KeyCodes.A,right:Phaser.Input.Keyboard.KeyCodes.RIGHT,d:Phaser.Input.Keyboard.KeyCodes.D,space:Phaser.Input.Keyboard.KeyCodes.SPACE,up:Phaser.Input.Keyboard.KeyCodes.UP,w:Phaser.Input.Keyboard.KeyCodes.W});
      // Keep keyboard state local to the game canvas and reset stale keys on focus changes.
      this.input.keyboard.enabled = true;
      const resetThisSceneInput = () => resetSceneInput(this);
      this.game.events.on(Phaser.Core.Events.BLUR, resetThisSceneInput);
      this.game.events.on(Phaser.Core.Events.FOCUS, resetThisSceneInput);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        this.game.events.off(Phaser.Core.Events.BLUR, resetThisSceneInput);
        this.game.events.off(Phaser.Core.Events.FOCUS, resetThisSceneInput);
      });
      this.add.text(24,22,"PREPOSITION QUEST · 3 WORLDS",{fontFamily:"system-ui, sans-serif",fontSize:"18px",fontStyle:"bold",color:"#17425b",stroke:"#ffffff",strokeThickness:3}).setScrollFactor(0).setDepth(10);
      this.hintText = this.add.text(24,49,"Jump OVER the crate!",{fontFamily:"system-ui, sans-serif",fontSize:"14px",color:"#17425b",stroke:"#ffffff",strokeThickness:2}).setScrollFactor(0).setDepth(10);
      this.scoreText = this.add.text(936,22,"COINS: 0 / 18",{fontFamily:"system-ui, sans-serif",fontSize:"18px",fontStyle:"bold",color:"#17425b",stroke:"#ffffff",strokeThickness:3}).setOrigin(1,0).setScrollFactor(0).setDepth(10);
      this.quizScoreText = this.add.text(936,49,`QUIZ: ${this.quizScore}`,{fontFamily:"system-ui, sans-serif",fontSize:"17px",fontStyle:"bold",color:"#176b3b",stroke:"#ffffff",strokeThickness:3}).setOrigin(1,0).setScrollFactor(0).setDepth(10);
      this.livesText = this.add.text(24,78,"LIVES: ♥ ♥ ♥",{fontFamily:"system-ui, sans-serif",fontSize:"18px",fontStyle:"bold",color:"#b51f45",stroke:"#ffffff",strokeThickness:3}).setScrollFactor(0).setDepth(10);
      this.checkpointStatusText = this.add.text(24,104,"CHECKPOINT: NOT ACTIVE",{fontFamily:"system-ui, sans-serif",fontSize:"13px",fontStyle:"bold",color:"#8b2b27",stroke:"#ffffff",strokeThickness:3}).setScrollFactor(0).setDepth(10);
      this.gameOverText = this.add.text(480,250,"GAME OVER",{fontFamily:"system-ui, sans-serif",fontSize:"42px",fontStyle:"bold",color:"#ffffff",stroke:"#7d2034",strokeThickness:8}).setOrigin(0.5).setScrollFactor(0).setDepth(30).setVisible(false);
      this.updateLivesText();
      this.collectText = this.add.text(w/2,76,"",{fontFamily:"system-ui, sans-serif",fontSize:"20px",fontStyle:"bold",color:"#9a6a00",stroke:"#ffffff",strokeThickness:4}).setOrigin(0.5,0).setScrollFactor(0).setDepth(10).setAlpha(0);
      this.quizText = this.add.text(480, h/2, "", {fontFamily:"system-ui, sans-serif",fontSize:"20px",color:"#17425b"}).setOrigin(0.5).setScrollFactor(0).setDepth(20).setAlpha(0);
      this.challengeIndex=0; this.challengeQuizActive=false;
      this.physics.world.resume();
    }
    updateLivesText(){ if(this.livesText) this.livesText.setText("LIVES: "+"♥ ".repeat(this.lives).trim()); }
    resetCoinsAfterDeath(){
      if(!this.coins || !this.coinPositions) return;
      this.coins.children.iterate((coin)=>{
        if(!coin || typeof coin.spawnX !== "number") return;
        coin.enableBody(true,coin.spawnX,coin.spawnY,true,true);
        coin.setDisplaySize(32,32);
        coin.refreshBody();
      });
      this.score=0;
      if(this.scoreText) this.scoreText.setText(`COINS: 0 / ${this.coinPositions.length}`);
    }
    handleEnemyHit(){
      if(this.invulnerable || this.deathInProgress || gameOver || paused || quizOpen) return;
      playSound("hurt");
      this.handlePitDeath("enemy");
    }
    handlePitDeath(source="pit"){
      if(this.deathInProgress || gameOver) return;
      this.deathInProgress=true;
      if(source!=="enemy") playSound("hurt");
      this.invulnerable=true;
      this.invulnerabilityRemaining=1500;
      this.lives=Math.max(0,this.lives-1);
      this.updateLivesText();
      clearInputs();
      this.player.setVelocity(0,0);
      this.player.body.reset(this.player.x,this.player.y);
      this.resetCoinsAfterDeath();
      if(this.lives<=0){
        playSound("disappear");
        gameOver=true; paused=false; quizOpen=false;
        this.invulnerable=false; this.invulnerabilityRemaining=0;
        if(this.shieldRing) this.shieldRing.setVisible(false);
        this.player.setAlpha(1);
        if (this.physics?.world?.pause) this.physics.world.pause();
        this.gameOverText.setVisible(true);
        pauseBtn.disabled=true;
        pausedBadge.hidden=true;
        el("gameOverMessage").textContent="You have no lives left. Start a new attempt to try again.";
        el("finalCoinScore").textContent=`COINS: ${this.score} / ${this.coinPositions.length}`;
        el("finalQuizScore").textContent=`QUIZ SCORE: ${this.quizScore}`;
        el("gameOverScreen").hidden=false;
        clearInputs();
        return;
      }
      // Respawn at the latest activated checkpoint, or at the level start by default.
      this.player.setPosition(this.respawnPosition.x,this.respawnPosition.y);
      this.player.setVelocity(0,0);
      this.player.setTexture("idle");
      this.player.setAlpha(1);
      this.jumpRequest=false; this.jumpWasDown=false; this.hasJumped=false;
      this.physics.world.resume();
      // Invulnerability lasts 1.5 seconds of active gameplay time; update() pauses the timer during Pause/quiz.
      this.invulnerabilityRemaining=1500;
      this.invulnerable=true;
      this.time.delayedCall(1000,()=>{this.deathInProgress=false;});
    }
    clearJumpRequest(){this.jumpRequest=false;this.jumpWasDown=false;}
    update(time,delta){
      if(paused || !started || quizOpen || gameOver || levelComplete || !this.player?.body) return;
      // Enemy patrol is bounded and uses the active scene update, so it freezes during Pause and quizzes.
      if(this.enemy?.active){
        if(this.enemy.x >= this.enemyPatrol.right) this.enemyDirection=-1;
        else if(this.enemy.x <= this.enemyPatrol.left) this.enemyDirection=1;
        this.enemy.x += this.enemyDirection*this.enemyPatrol.speed*(delta/1000);
        this.enemy.body.updateFromGameObject();
        this.enemyEyes.forEach((eye,index)=>{
          const offsets=[[-9,-5],[9,-5],[-8,-4],[10,-4]][index];
          eye.setPosition(this.enemy.x+offsets[0],this.enemy.y+offsets[1]);
        });
      }
      if(this.caveBat?.active){
        if(this.caveBat.x>=this.caveBatPatrol.right)this.caveBatDirection=-1;
        else if(this.caveBat.x<=this.caveBatPatrol.left)this.caveBatDirection=1;
        this.caveBat.x += this.caveBatDirection*this.caveBatPatrol.speed*(delta/1000);
        this.caveBat.y = 350 + Math.sin(time/180)*10;
        this.caveBat.setScale(1,this.caveBatDirection===1?1:0.88);
        this.caveBat.body.updateFromGameObject();
      }
      // Invulnerability time advances only while active gameplay is running.
      if(this.invulnerable){
        this.invulnerabilityRemaining=Math.max(0,this.invulnerabilityRemaining-delta);
        this.shieldRing.setPosition(this.player.x,this.player.y).setVisible(true);
        this.player.setAlpha(Math.floor(this.invulnerabilityRemaining/100)%2===0?0.45:1);
        if(this.invulnerabilityRemaining<=0){
          this.invulnerable=false;
          this.player.setAlpha(1);
          this.shieldRing.setVisible(false);
        }
      } else if(this.shieldRing?.visible){ this.shieldRing.setVisible(false); }
      // Keep horizontal movement inside the world while allowing vertical pit falls.
      if(this.player.x < 32){ this.player.x=32; this.player.setVelocityX(0); }
      if(this.player.x > 3368){ this.player.x=3368; this.player.setVelocityX(0); }
      if(!this.deathInProgress && this.player.y > 620){ this.handlePitDeath(); return; }
      // Activate the checkpoint only when the player reaches its zone while grounded.
      if(!this.checkpointActive && this.player.body.blocked.down && Math.abs(this.player.x-this.checkpointX)<30){
        this.checkpointActive=true;
        playSound("magic");
        this.respawnPosition={x:this.checkpointX,y:this.startPosition.y};
        this.checkpointFlag.setFillStyle(0x35b86b);
        this.checkpointLabel.setColor("#176b3b");
        this.checkpointStatusText.setText("CHECKPOINT: ACTIVE").setColor("#176b3b");
        const notice=this.add.text(this.player.x,this.player.y-58,"CHECKPOINT ACTIVATED! ✦",{fontFamily:"system-ui, sans-serif",fontSize:"14px",fontStyle:"bold",color:"#176b3b",stroke:"#ffffff",strokeThickness:4}).setOrigin(0.5).setDepth(12);
        this.tweens.add({targets:notice,y:notice.y-24,alpha:0,scale:1.08,duration:1100,onComplete:()=>notice.destroy()});
        this.tweens.add({targets:this.checkpointFlag,angle:{from:-5,to:5},yoyo:true,repeat:2,duration:110});
      }
      const left=controls.left||physicalKeys.has("ArrowLeft")||this.keys.left.isDown||this.keys.a.isDown;
      const right=controls.right||physicalKeys.has("ArrowRight")||this.keys.right.isDown||this.keys.d.isDown;
      const jumpDown=controls.jump||physicalKeys.has("ArrowUp")||physicalKeys.has(" ")||this.keys.space.isDown||this.keys.up.isDown||this.keys.w.isDown;
      if(jumpDown&&!this.jumpWasDown)this.jumpRequest=true;
      this.jumpWasDown=jumpDown;
      const speed=230;
      if(left&&!right){this.player.setVelocityX(-speed);this.player.setFlipX(true);this.facing=-1;}
      else if(right&&!left){this.player.setVelocityX(speed);this.player.setFlipX(false);this.facing=1;}
      else this.player.setVelocityX(0);
      if(this.jumpRequest && this.player.body.blocked.down){this.player.setVelocityY(-490); this.hasJumped=true; playSound("jump");}
      this.jumpRequest=false;
      // Trigger each challenge quiz when the player reaches the end of its marked zone.
      const challenge=this.challengeIndex;
      // World-entry quizzes trigger as soon as the player steps into the new world, before reaching its sign.
      const thresholds=[585,900,1115,1360,1840,2250,2660,3000];
      if(!this.challengeQuizActive && challenge<thresholds.length && this.player.x>thresholds[challenge] && this.player.body.blocked.down){
        if(challenge===0 && !this.hasJumped) { /* the OVER challenge requires a jump */ }
        else { this.challengeQuizActive=true; openQuiz(challenge); }
      }
      // The finish gate is a real progression goal, not just scenery. Require all four quizzes first.
      if(this.player.x >= this.finishGateX-30 && this.player.body.blocked.down){
        const allQuizzesDone=this.quizCompleted.every(Boolean);
        if(allQuizzesDone){
          playSound("gem");
          levelComplete=true; this.levelComplete=true; this.player.setVelocity(0,0); if (this.physics?.world?.pause) this.physics.world.pause();
          el("victoryCoinScore").textContent=`COINS: ${this.score} / ${this.coinPositions.length}`;
          el("victoryQuizScore").textContent=`QUIZ SCORE: ${this.quizScore} / 24`;
          const praise=this.quizScore>=20?"Amazing work! You're a Preposition Pro!":this.quizScore>=13?"Great effort! You mastered the quest!":"Quest complete! Keep practising your prepositions!";
          el("victoryPraise").textContent=praise;
          el("victoryStars").textContent="★".repeat(Math.max(1,Math.min(4,Math.ceil(this.quizScore/3))))+"☆".repeat(4-Math.max(1,Math.min(4,Math.ceil(this.quizScore/3))));
          el("victoryScreen").hidden=false; pauseBtn.disabled=true; clearInputs(); return;
        } else {
          this.finishStatus.setText(`${this.quizCompleted.filter(Boolean).length}/8 QUIZZES DONE`);
          this.hintText.setText("Complete all eight preposition challenges before the FINISH gate!");
        }
      }
      if(!this.player.body.blocked.down && this.player.body.velocity.y < -20)this.player.setTexture("jump");
      else if(Math.abs(this.player.body.velocity.x)>5)this.player.anims.play("walk",true);
      else {this.player.anims.stop();this.player.setTexture("idle");}
    }
  }
  function createGame(){
    if(typeof Phaser === "undefined"){showError("Phaser 3 could not load. Connect to the internet to load Phaser from its CDN, then reload this page.");return;}
    game=new Phaser.Game({type:Phaser.AUTO,parent:"game-container",width:960,height:540,backgroundColor:"#9ee4f4",physics:{default:"arcade",arcade:{gravity:{y:1100},debug:false}},scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH,width:960,height:540},render:{antialias:true,pixelArt:false},scene:[GameScene]});
    game.events.once("ready",()=>{});
  }
  function begin(){ if(started)return; unlockAudio(); playSound("select"); started=true; gameOver=false; levelComplete=false; startScreen.hidden=true; el("gameOverScreen").hidden=true; el("victoryScreen").hidden=true; pauseBtn.disabled=false; restartBtn.disabled=false; createGame(); }
  function setPaused(value){
    playSound("select");
    if(!started||!game||quizOpen||gameOver||levelComplete)return;
    paused=value;
    clearInputs();
    if(sceneRef?.physics?.world){ if(paused) sceneRef.physics.world.pause?.(); else sceneRef.physics.world.resume?.(); }
    pausedBadge.hidden=!paused;
    pauseBtn.textContent=paused?"▶ Resume":"Ⅱ Pause";
  }
  const challengeData = [
    {id:"challenge-01",world:"forest-trail",mode:"multiple-choice",type:"Visual Multiple Choice",label:"ALONG",title:"Where is the explorer walking?",clue:"The explorer follows the path beside the direction sign.",image:"along.png",prompt:"Choose the preposition that describes the explorer's path.",correct:"along",options:[{value:"behind",label:"BEHIND"},{value:"along",label:"ALONG"},{value:"under",label:"UNDER"},{value:"between",label:"BETWEEN"}],hint:"The explorer is following the length of the path.",feedback:"Correct! The explorer is walking ALONG the path."},
    {id:"challenge-02",world:"forest-trail",mode:"multiple-choice",type:"Visual Multiple Choice",label:"OVER",title:"Where does the bridge go over?",clue:"The bridge is above the river and crosses from one bank to the other.",image:"over.png",prompt:"Choose the preposition that describes the bridge's position above the river.",correct:"over",options:[{value:"under",label:"UNDER"},{value:"over",label:"OVER"},{value:"inside",label:"INSIDE"},{value:"behind",label:"BEHIND"}],hint:"Look at the bridge compared with the river beneath it.",feedback:"Correct! The bridge goes OVER the river."},
    {id:"challenge-03",world:"forest-trail",mode:"drag-drop",type:"Sentence Builder",label:"INTO",title:"Build a sentence about the explorer.",clue:"The explorer is moving from outside the cave to its inside.",image:"into.png",prompt:"Tap the words in the correct order to describe the picture.",correct:"the explorer goes into the cave",acceptedAnswers:["the explorer goes into the cave","the explorer walks into the cave","the explorer is going into the cave"],sentenceWords:["The","explorer","goes","into","the","cave","under","over","around"],options:[{value:"sentence-under",label:"The explorer goes under the cave."},{value:"sentence-over",label:"The explorer jumps over the cave."},{value:"sentence-into",label:"The explorer goes into the cave."},{value:"sentence-around",label:"The explorer walks around the cave."}],hint:"The explorer is crossing the entrance and moving inside.",feedback:"Correct! The explorer goes INTO the cave."},
    {id:"challenge-04",world:"forest-trail",mode:"typing",acceptedAnswers:["across","across the gap","the explorer jumps across the gap"],type:"Typing Challenge",label:"ACROSS",title:"Complete the sentence!",clue:"The explorer jumps from one side of the gap to the other.",image:"across.png",prompt:"The explorer jumps ___ the gap.",correct:"across",options:[{value:"under",label:"UNDER"},{value:"across",label:"ACROSS"},{value:"into",label:"INTO"},{value:"behind",label:"BEHIND"}],hint:"The movement starts on one side and reaches the other side.",feedback:"Correct! The explorer jumps ACROSS the gap."},
    {id:"challenge-05",world:"mystery-cave",mode:"multiple-choice",type:"Context Clue",label:"INSIDE",title:"Where is the cat?",clue:"The cat is within the open treasure chest.",image:"inside.png",prompt:"Choose the word that describes where the cat is.",correct:"inside",options:[{value:"behind",label:"BEHIND"},{value:"inside",label:"INSIDE"},{value:"over",label:"OVER"},{value:"next-to",label:"NEXT TO"}],hint:"The cat is surrounded by the sides of the chest, not beside it.",feedback:"Exactly! The cat is INSIDE the treasure chest."},
    {id:"challenge-06",world:"mystery-cave",mode:"speaking",required:true,acceptedAnswers:["under","the dog is under the table","the dog sleeps under the table","the dog is sleeping under the table"],type:"Speaking Challenge",label:"UNDER",title:"Say where the dog is sleeping.",clue:"The dog is sleeping beneath the tabletop.",image:"under.png",prompt:"Say a sentence describing where the dog is sleeping.",correct:"The dog is sleeping under the table.",options:[{value:"behind",label:"BEHIND THE TABLE"},{value:"under",label:"UNDER THE TABLE"},{value:"on",label:"ON THE TABLE"},{value:"inside",label:"INSIDE THE TABLE"}],hint:"Look at the space between the tabletop and the floor.",feedback:"Correct! The dog is sleeping UNDER the table."},
    {id:"challenge-07",world:"sky-temple",mode:"picture-sentence",type:"Picture-to-Sentence Challenge",label:"BEHIND",title:"Describe the hidden backpack.",clue:"The backpack is partly hidden by the tree trunk.",image:"behind.png",prompt:"Look at the picture and type a complete sentence about where the backpack is.",correct:"The backpack is behind the tree.",acceptedAnswers:["The backpack is behind the tree.","The backpack is behind the tree","The backpack is behind it"],hint:"The tree blocks part of the backpack from view.",feedback:"Well done! The backpack is BEHIND the tree."},
    {id:"challenge-08",world:"sky-temple",mode:"typing",acceptedAnswers:["in front of the golden door","stand in front of the golden door","the explorer is in front of the golden door","in front of"],type:"Sentence Typing Challenge",label:"IN FRONT OF",title:"Complete the final clue.",clue:"The explorer stands facing the golden temple door.",image:"in-front-of.png",prompt:"The explorer is standing ___ the golden door.",correct:"in front of",options:[{value:"behind",label:"BEHIND"},{value:"under",label:"UNDER"},{value:"in front of",label:"IN FRONT OF"},{value:"between",label:"BETWEEN"}],hint:"The explorer is on the side of the door that faces outward.",feedback:"Correct! The explorer is standing IN FRONT OF the golden door."}
  ];
  const quizManager = window.PrepositionQuizManager;
  if(!quizManager) throw new Error("Quiz Manager failed to load.");
  challengeData.forEach((question, index) => {
    if(!quizManager.validateQuestion(question)) throw new Error("Invalid quiz question data at index " + index);
  });
  function stopSpeechRecognition(){
    if(speechRecognition){ try{speechRecognition.onresult=null;speechRecognition.onerror=null;speechRecognition.onend=null;speechRecognition.stop();}catch(_e){} speechRecognition=null; }
    const stopButton=el("stopSpeakingBtn"); if(stopButton) stopButton.hidden=true;
  }
  function showTypingFallback(message){
    stopSpeechRecognition(); speechFallbackShown=true;
    el("speakingChallenge").hidden=true;
    el("typingAnswerForm").hidden=false;
    el("typingAnswerInput").value=""; el("typingAnswerInput").disabled=false;
    el("typingAnswerLabel").textContent="Type your answer instead";
    el("typingAnswerHelp").textContent="Microphone input is optional now. Type the preposition or a valid sentence.";
    el("quizFeedback").textContent=message || "You can finish this challenge by typing your answer.";
    el("typingAnswerInput").focus({preventScroll:true});
  }
  function startSpeaking(){
    const SpeechRecognitionAPI=window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecognitionAPI){ showTypingFallback("Speech recognition is not supported in this browser. Please type your answer instead."); return; }
    if(speechRecognition) stopSpeechRecognition();
    if(speechAttempts>=MAX_SPEECH_ATTEMPTS){ showTypingFallback("You’ve used your speaking attempts. Type your answer to continue."); return; }
    speechAttempts++;
    el("speechStatus").textContent=`Listening… attempt ${speechAttempts} of ${MAX_SPEECH_ATTEMPTS}. Speak clearly in English.`;
    el("speechTranscript").textContent="";
    el("startSpeakingBtn").disabled=true; el("stopSpeakingBtn").hidden=false;
    let recognition;
    try{ recognition=new SpeechRecognitionAPI(); }
    catch(_e){ showTypingFallback("Could not start speech recognition. Please type your answer."); return; }
    speechRecognition=recognition; recognition.lang="en-US"; recognition.interimResults=false; recognition.maxAlternatives=3; recognition.continuous=false;
    recognition.onresult=(event)=>{
      const transcript=Array.from(event.results||[]).map(result=>result[0]?.transcript||"").join(" ").trim();
      el("speechTranscript").textContent=transcript ? `Heard: “${transcript}”` : "I couldn’t hear a clear answer.";
      stopSpeechRecognition(); el("startSpeakingBtn").disabled=false;
      if(!transcript){ handleSpeechRetry("I didn’t catch that. Try speaking a little louder."); return; }
      const data=challengeData[activeChallenge];
      if(quizManager.validateTypedAnswer(transcript,data)){
        answerQuiz(transcript,el("startSpeakingBtn"));
      }else{
        // A recognised but incorrect answer is a language attempt and affects scoring.
        answerQuiz(transcript,el("startSpeakingBtn"));
        if(quizOpen && speechAttempts<MAX_SPEECH_ATTEMPTS){ el("speechStatus").textContent="That answer doesn’t match yet. You can try speaking again."; }
        else if(quizOpen){ showTypingFallback("That wasn’t accepted. Type your answer to finish this challenge."); }
      }
    };
    recognition.onerror=(event)=>{
      stopSpeechRecognition(); el("startSpeakingBtn").disabled=false;
      const reason=event.error==="not-allowed" || event.error==="service-not-allowed" ? "Microphone permission was denied." : event.error==="no-speech" ? "No speech was detected." : "Speech recognition didn’t work this time.";
      handleSpeechRetry(reason+" You can retry or switch to typing.");
    };
    recognition.onend=()=>{ if(speechRecognition===recognition){ speechRecognition=null; el("stopSpeakingBtn").hidden=true; el("startSpeakingBtn").disabled=false; } };
    try{ recognition.start(); }catch(_e){ stopSpeechRecognition(); el("startSpeakingBtn").disabled=false; handleSpeechRetry("Could not start the microphone. Please retry or type instead."); }
  }
  function handleSpeechRetry(message){
    el("speechStatus").textContent=message;
    el("startSpeakingBtn").disabled=false;
    if(speechAttempts>=MAX_SPEECH_ATTEMPTS) showTypingFallback("Speaking attempts are finished. Type your answer to continue.");
  }
  function openQuiz(index=0){
    if(!challengeData[index] || sceneRef?.quizCompleted[index]) return;
    quizOpen = true; activeChallenge=index; clearInputs();
    if(sceneRef?.sys?.isActive?.() && sceneRef?.physics?.world){ sceneRef.physics.world.pause?.(); if(sceneRef.player?.body) sceneRef.player.setVelocity(0,0); }
    const data=challengeData[index], panel=el("quizScreen"); if(panel) panel.hidden=false;
    const worldLabel = quizManager.worldForQuestion(index);
    el("quizEyebrow").textContent=`${worldLabel} · ${data.type.toUpperCase()} · CHALLENGE 0${index+1}`;
    el("quizClueImage").src="assets/clues/"+data.image;
    el("quizClueImage").alt=data.clue;
    el("quizClueCaption").textContent=data.clue;
    el("quizTitle").textContent=data.title;
    el("quizPrompt").textContent=data.prompt;
    el("quizFeedback").textContent=data.mode === "typing" ? "Type your answer below." : data.mode === "speaking" ? "Speaking is required for this challenge, but typing is available if needed." : "Choose your answer.";
    const mode=quizManager.getMode(data);
    const typingMode = mode === "typing" || mode === "picture-sentence";
    const builderMode = mode === "drag-drop";
    const speakingMode = mode === "speaking";
    stopSpeechRecognition(); speechAttempts=0; speechFallbackShown=false;
    el("answerChoiceList").hidden=typingMode || builderMode || speakingMode;
    el("typingAnswerForm").hidden=!typingMode;
    el("sentenceBuilder").hidden=!builderMode;
    el("speakingChallenge").hidden=!speakingMode;
    el("switchToTypingBtn").hidden=!speakingMode;
    el("startSpeakingBtn").hidden=false; el("startSpeakingBtn").disabled=false;
    el("speechStatus").textContent="Press Start Speaking, then allow microphone access.";
    el("speechTranscript").textContent="";
    if(speakingMode){ el("speakingInstruction").textContent="Say “between” clearly, or say a full sentence about the key."; el("switchToTypingBtn").hidden=false; }
    if(builderMode) resetSentenceBuilder(data);
    el("typingAnswerInput").value="";
    el("typingAnswerInput").setAttribute("aria-label", data.mode === "picture-sentence" ? "Type a sentence describing the picture" : "Type your answer");
    el("typingAnswerLabel").textContent=data.mode === "picture-sentence" ? "Write a sentence about the picture" : "Type your answer";
    el("submitTypingAnswerBtn").disabled=false;
    el("submitTypingAnswerBtn").classList.remove("correct","incorrect");
    el("quizHint").hidden=true; el("quizHint").textContent=data.hint;
    el("hintBtn").hidden=false; el("hintBtn").disabled=false; el("hintBtn").textContent="Show Hint";
    const buttons=[...document.querySelectorAll("[data-answer]")];
    // Non-choice challenges (typing/picture-sentence/speaking) may not define options.
    // Treat missing options as an empty list rather than indexing undefined.
    const options = Array.isArray(data.options) ? data.options : [];
    buttons.forEach((b,i)=>{ const option=options[i]; if(!option){b.hidden=true;return;} b.hidden=false;b.dataset.answer=option.value;b.textContent=option.label;b.disabled=false;b.classList.remove("correct","incorrect"); });
    el("continueQuizBtn").hidden=true;
    el("typingAnswerInput").disabled=false;
    el("submitTypingAnswerBtn").disabled=false;
  }
  function answerQuiz(answer, button){
    if(!quizOpen || button.disabled)return;
    const data=challengeData[activeChallenge], feedback=el("quizFeedback");
    const mode=quizManager.getMode(data);
    const isTyping = mode === "typing" || mode === "picture-sentence" || mode === "drag-drop" || mode === "speaking";
    const isCorrect = isTyping ? quizManager.validateTypedAnswer(answer, data) : quizManager.validateChoice(answer, data);
    if(!isCorrect){
      playSound("bump");
      if(sceneRef) sceneRef.quizWrongAttempts[activeChallenge]++;
      feedback.textContent=mode === "drag-drop" ? "Not quite yet. Rearrange the words and try again." : mode === "speaking" ? "Not quite yet. Try saying BETWEEN, or use Type instead." : isTyping ? "Not quite yet. Check the preposition and try again." : "Not quite! Try again and think about the picture or route.";
      feedback.classList.remove("feedback-correct","feedback-pop");
      feedback.classList.add("feedback-try-again","feedback-shake");
      button.classList.add("incorrect");
      scheduleUiCleanup(()=>feedback.classList.remove("feedback-shake"),420);
      if(mode === "speaking"){
        button.classList.remove("incorrect"); button.disabled=false;
        if(speechAttempts>=MAX_SPEECH_ATTEMPTS) showTypingFallback("You’ve used your speaking attempts. Type your answer to continue.");
      }
      return;
    }
    playSound("gem");
    if(sceneRef && !sceneRef.quizCompleted[activeChallenge]){
      const mistakes=sceneRef.quizWrongAttempts[activeChallenge];
      const points=quizManager.calculatePoints(mistakes);
      sceneRef.quizScore+=points;
      sceneRef.quizCompleted[activeChallenge]=true;
      sceneRef.quizScoreText.setText(`QUIZ: ${sceneRef.quizScore}`);
      feedback.textContent=`${data.feedback} +${points} quiz points (${mistakes} incorrect ${mistakes===1?"answer":"answers"}).`;
    } else { feedback.textContent=data.feedback; }
    feedback.classList.remove("feedback-try-again","feedback-shake");
    feedback.classList.add("feedback-correct","feedback-pop");
    scheduleUiCleanup(()=>feedback.classList.remove("feedback-pop"),420);
    button.classList.add("correct");
    document.querySelectorAll("[data-answer]").forEach(b=>b.disabled=true);
    el("submitTypingAnswerBtn").disabled=true;
    el("typingAnswerInput").disabled=true;
    el("submitSentenceBtn").disabled=true;
    el("undoWordBtn").disabled=true; el("resetWordsBtn").disabled=true;
    document.querySelectorAll(".sentence-word").forEach(b=>b.disabled=true);
    el("hintBtn").disabled=true;
    el("continueQuizBtn").hidden=false;
  }
  let sentenceBuild=[];
  function renderSentenceBuilder(data){
    const slots=el("sentenceSlots"), bank=el("sentenceWordBank");
    slots.replaceChildren(); bank.replaceChildren();
    if(!sentenceBuild.length){const empty=document.createElement("span");empty.className="builder-placeholder";empty.textContent="Your sentence will appear here…";slots.append(empty);}
    sentenceBuild.forEach((word,index)=>{const b=document.createElement("button");b.type="button";b.className="sentence-word placed-word";b.textContent=word;b.setAttribute("aria-label",`Remove ${word}`);b.title="Tap to remove this word";b.addEventListener("click",()=>{if(el("submitSentenceBtn").disabled)return;sentenceBuild.splice(index,1);renderSentenceBuilder(data);});slots.append(b);});
    (data.sentenceWords||[]).forEach((word,index)=>{if(sentenceBuild.filter(w=>w===word).length >= (data.sentenceWords.slice(0,index+1).filter(w=>w===word).length)) return;
      const b=document.createElement("button");b.type="button";b.className="sentence-word";b.textContent=word;b.draggable=true;b.dataset.word=word;b.addEventListener("click",()=>{if(!el("submitSentenceBtn").disabled){sentenceBuild.push(word);renderSentenceBuilder(data);}});
      b.addEventListener("dragstart",e=>{e.dataTransfer.setData("text/plain",word);e.dataTransfer.effectAllowed="copy";});bank.append(b);});
  }
  function resetSentenceBuilder(data=challengeData[activeChallenge]){sentenceBuild=[];renderSentenceBuilder(data);el("submitSentenceBtn").disabled=false;el("undoWordBtn").disabled=false;el("resetWordsBtn").disabled=false;}
  function setupSentenceBuilder(){
    const slots=el("sentenceSlots");
    slots.addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";});
    slots.addEventListener("drop",e=>{e.preventDefault();if(el("sentenceBuilder").hidden||el("submitSentenceBtn").disabled)return;const word=e.dataTransfer.getData("text/plain");if(word && challengeData[activeChallenge].sentenceWords.includes(word)){sentenceBuild.push(word);renderSentenceBuilder(challengeData[activeChallenge]);}});
    el("undoWordBtn").addEventListener("click",()=>{sentenceBuild.pop();renderSentenceBuilder(challengeData[activeChallenge]);});
    el("resetWordsBtn").addEventListener("click",()=>resetSentenceBuilder());
    el("submitSentenceBtn").addEventListener("click",()=>{if(!sentenceBuild.length){el("quizFeedback").textContent="Tap some words to build your sentence first.";return;}answerQuiz(sentenceBuild.join(" "),el("submitSentenceBtn"));});
  }
  setupSentenceBuilder();
  el("startSpeakingBtn").addEventListener("click",startSpeaking);
  el("stopSpeakingBtn").addEventListener("click",()=>{stopSpeechRecognition();el("startSpeakingBtn").disabled=false;el("speechStatus").textContent="Stopped listening. You can try again or type instead.";});
  el("switchToTypingBtn").addEventListener("click",()=>showTypingFallback("Type your answer below to complete the speaking challenge."));
  function showQuizHint(){
    if(!quizOpen)return;
    const hint=el("quizHint");
    hint.hidden=false;
    el("hintBtn").textContent="Hint Shown";
    el("hintBtn").disabled=true;
  }
  function continueQuiz(){
    playSound("magic");
    stopSpeechRecognition(); quizOpen=false; el("quizScreen").hidden=true; el("continueQuizBtn").hidden=true;
    el("typingAnswerInput").disabled=false; el("typingAnswerForm").hidden=true; el("answerChoiceList").hidden=false; el("sentenceBuilder").hidden=true; el("speakingChallenge").hidden=true;
    el("submitSentenceBtn").disabled=false; el("undoWordBtn").disabled=false; el("resetWordsBtn").disabled=false;
    if(sceneRef){
      sceneRef.challengeQuizActive=false;
      sceneRef.challengeIndex=activeChallenge+1;
      const hints=["Challenge cleared! Walk UNDER the beam.","Great! Go THROUGH the tunnel.","Now find the route AROUND the rock.","The forest trail continues. Watch for the next challenge.","Welcome to Mystery Cave! Solve the clue to begin your cave mission.","Keep exploring Mystery Cave and find the silver key.","Welcome to Sky Temple! Solve the clue to begin your temple mission.","Complete the final Sky Temple clue to reach the finish."];
      sceneRef.hintText.setText(hints[Math.min(activeChallenge, hints.length-1)]);
      if(sceneRef.sys?.isActive?.()) sceneRef.physics?.world?.resume?.();
      sceneRef.quizText.setText(`✓ ${challengeData[activeChallenge].label}!`).setAlpha(1).setScale(0.9);
      sceneRef.tweens.killTweensOf(sceneRef.quizText);
      sceneRef.tweens.add({targets:sceneRef.quizText,alpha:0,scale:1.12,y:sceneRef.quizText.y-16,delay:800,duration:650});
    }
    clearInputs();
  }
  function restart(){
    playSound("select");
    if(!started || restartInProgress) return;
    restartInProgress = true;
    clearUiTimers(); recovering = false;
    paused=false; quizOpen=false; gameOver=false; levelComplete=false; activeChallenge=0;
    stopSpeechRecognition(); el("quizScreen").hidden=true; el("gameOverScreen").hidden=true; el("victoryScreen").hidden=true;
    el("continueQuizBtn").hidden=true; pausedBadge.hidden=true; errorScreen.hidden=true;
    pauseBtn.disabled=false; pauseBtn.textContent="Ⅱ Pause"; clearInputs();
    if(!game){ restartInProgress=false; createGame(); return; }
    try {
      // Prefer Phaser's own restart lifecycle when the scene still exists. This avoids
      // issuing stop() and start() back-to-back while a previous transition is queued.
      const activeScene = sceneRef;
      if (activeScene && activeScene.sys && activeScene.sys.settings && activeScene.sys.settings.key === "GameScene") {
        activeScene.scene.restart();
      } else {
        // A scene may have crashed or already shut down; queue a clean start through the manager.
        game.scene.start("GameScene");
        // If startup fails, unlock the recovery button path rather than locking the UI forever.
        scheduleUiCleanup(() => { if (restartInProgress && !sceneRef) restartInProgress = false; }, 1800);
      }
    } catch (error) {
      restartInProgress = false;
      reportRuntimeError(error?.message || "Could not restart the game scene");
    }
  }
  function recoverGame(){
    if(recovering) return;
    recovering = true;
    clearUiTimers();
    if(!started){ errorScreen.hidden=true; startScreen.hidden=false; recovering=false; return; }
    restart();
  }
  el("recoverBtn").addEventListener("click",recoverGame); pauseBtn.addEventListener("click",()=>setPaused(!paused)); restartBtn.addEventListener("click",restart); el("gameOverRestartBtn").addEventListener("click",restart); el("victoryRestartBtn").addEventListener("click",restart);
  // Bind directly to the actual answer buttons. The buttons are static HTML elements;
  // direct listeners avoid relying on delegated events through the game canvas.
  document.querySelectorAll("#answerChoiceList [data-answer]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || el("quizScreen").hidden) return;
      // The visible quiz panel is authoritative. Recover quiz state if UI and state drift.
      if (!quizOpen) quizOpen = true;
      answerQuiz(button.dataset.answer, button);
    });
  });

  el("typingAnswerForm").addEventListener("submit",event=>{
    event.preventDefault();
    const input=el("typingAnswerInput"), submit=el("submitTypingAnswerBtn");
    if(!input.value.trim()) { el("quizFeedback").textContent="Please type an answer first."; input.focus(); return; }
    answerQuiz(input.value,submit);
  });
  el("continueQuizBtn").addEventListener("click",continueQuiz);
  el("hintBtn").addEventListener("click",showQuizHint);
  document.querySelectorAll(".touch-btn").forEach(button=>{
    const key=button.dataset.control;
    const down=e=>{e.preventDefault();if(!started||paused||gameOver||levelComplete||quizOpen)return;try{button.setPointerCapture(e.pointerId)}catch(_){} heldPointers.set(e.pointerId,key);controls[key]=true;button.classList.add("active");};
    const up=e=>{if(e.cancelable)e.preventDefault();heldPointers.delete(e.pointerId);controls[key]=[...heldPointers.values()].includes(key);if(!controls[key])button.classList.remove("active");};
    button.addEventListener("pointerdown",down);button.addEventListener("pointerup",up);button.addEventListener("pointercancel",up);button.addEventListener("lostpointercapture",up);button.addEventListener("contextmenu",e=>e.preventDefault());
  });
  function isGameControlKey(key){return ["ArrowLeft","ArrowRight","ArrowUp"," "].includes(key);}
  function isInteractiveTarget(target){
    return !!target.closest("button, input, textarea, select, a, [contenteditable='true']");
  }
  // Let text fields receive typing keys before Phaser's global keyboard manager.
  // Phaser captures gameplay keys such as Space and A; without this guard those
  // keys may be swallowed while a quiz input has focus.
  const typingTargets = "input, textarea, select, [contenteditable='true']";
  document.addEventListener("keydown", e => {
    if (e.target instanceof Element && e.target.matches(typingTargets)) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("keyup", e => {
    if (e.target instanceof Element && e.target.matches(typingTargets)) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener("keydown",e=>{
    // Keep normal keyboard navigation available; capture game keys only during active play.
    if(started && !paused && !quizOpen && !gameOver && !levelComplete && isGameControlKey(e.key) && !isInteractiveTarget(e.target)) e.preventDefault();
    if(!e.repeat && isGameControlKey(e.key) && started && !paused && !quizOpen && !gameOver && !levelComplete) physicalKeys.add(e.key);
  },{passive:false});
  window.addEventListener("keyup",e=>{
    if(started && isGameControlKey(e.key) && !isInteractiveTarget(e.target)) e.preventDefault();
    physicalKeys.delete(e.key);
  },{passive:false});
  function resetPhysicalKeys(){ resetSceneInput(sceneRef); }
  window.addEventListener("blur",resetPhysicalKeys);
  document.addEventListener("visibilitychange",()=>{ if(document.hidden) resetPhysicalKeys(); });
  window.addEventListener("pagehide",resetPhysicalKeys);
  window.addEventListener("pointerup", e => {
    // A pointer release outside a touch button must never leave a virtual key held.
    if (heldPointers.has(e.pointerId)) {
      const key = heldPointers.get(e.pointerId);
      heldPointers.delete(e.pointerId);
      controls[key] = [...heldPointers.values()].includes(key);
      if (!controls[key]) document.querySelector(`[data-control="${key}"]`)?.classList.remove("active");
    }
  }, true);
})();