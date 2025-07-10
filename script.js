import confetti from 'canvas-confetti';

const gameArea = document.getElementById('game-area');
const scoreEl = document.getElementById('score');
let score = 0;
let audioContext;
let popSoundBuffer;
let audioInitialized = false;

// --- Audio Setup ---
async function initializeAudio() {
    if (audioInitialized) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const response = await fetch('pop.mp3');
        const arrayBuffer = await response.arrayBuffer();
        popSoundBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioInitialized = true;
    } catch (error) {
        console.error('Error initializing audio:', error);
    }
}

function playPopSound() {
    if (!audioInitialized || !popSoundBuffer) {
        console.log("Audio not ready");
        return;
    }
    // Resume context if it was suspended
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    const source = audioContext.createBufferSource();
    source.buffer = popSoundBuffer;
    source.connect(audioContext.destination);
    source.start(0);
}

// --- Pimple Logic ---
function createPimple() {
    if (document.querySelectorAll('.pimple:not(.popped)').length >= 15) {
        return; // Don't overcrowd the screen
    }

    const pimple = document.createElement('div');
    pimple.classList.add('pimple');
    
    // Random size for variety
    const size = Math.random() * 20 + 20; // between 20px and 40px
    pimple.style.width = `${size}px`;
    pimple.style.height = `${size}px`;

    const gameRect = gameArea.getBoundingClientRect();
    
    // Ensure pimple is fully within the game area
    const x = Math.random() * (gameRect.width - size);
    const y = Math.random() * (gameRect.height - size);

    pimple.style.left = `${x}px`;
    pimple.style.top = `${y}px`;

    pimple.addEventListener('click', popPimple);

    gameArea.appendChild(pimple);
}

function popPimple(event) {
    const pimple = event.currentTarget;
    if (pimple.classList.contains('popped')) return;

    playPopSound();
    
    pimple.classList.add('popped');
    pimple.removeEventListener('click', popPimple);

    score++;
    scoreEl.textContent = score;

    // Confetti that looks like a splat
    const rect = pimple.getBoundingClientRect();
    const origin = {
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight
    };

    confetti({
        particleCount: Math.floor(Math.random() * 20 + 30),
        spread: 70,
        angle: Math.random() * 360,
        startVelocity: 25,
        origin: origin,
        colors: ['#FFFF00', '#FFFACD', '#FAFAD2', '#FFFFFF'],
        scalar: Math.random() * 0.5 + 0.75
    });

    setTimeout(() => {
        if (pimple.parentElement) {
            pimple.parentElement.removeChild(pimple);
        }
    }, 800);
}

// --- Game Initialization ---
function startGame() {
    // Initial audio setup requires user interaction
    document.body.addEventListener('click', initializeAudio, { once: true });
    
    score = 0;
    scoreEl.textContent = score;
    gameArea.innerHTML = '';

    // Initial burst of pimples
    for(let i=0; i<5; i++) {
        createPimple();
    }
    
    // Spawn pimples at random intervals
    function spawnLoop() {
        createPimple();
        const nextSpawnTime = Math.random() * 1200 + 400; // between 0.4s and 1.6s
        setTimeout(spawnLoop, nextSpawnTime);
    }
    
    spawnLoop();
}

startGame();

