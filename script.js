import confetti from 'canvas-confetti';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const gameArea = document.getElementById('game-area');
const scoreEl = document.getElementById('score');
const loadingOverlay = document.getElementById('loading-overlay');
let score = 0;
let audioContext;
let popSoundBuffer;
let audioInitialized = false;

// --- Three.js Setup ---
let scene, camera, renderer, faceMesh, controls;
let raycaster, mouse;
const pimples = [];
const MAX_PIMPLES = 20;

function init3D() {
    scene = new THREE.Scene();
    scene.background = null; 

    const gameRect = gameArea.getBoundingClientRect();
    camera = new THREE.PerspectiveCamera(75, gameRect.width / gameRect.height, 0.1, 1000);
    camera.position.z = 2.5;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(gameRect.width, gameRect.height);
    gameArea.appendChild(renderer.domElement);
    
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 4;
    controls.target.set(0, -0.2, 0);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    loadFaceModel();

    // Event listeners for interaction
    gameArea.addEventListener('click', onCanvasClick);
    window.addEventListener('resize', onWindowResize);
}

function loadFaceModel() {
    const loader = new GLTFLoader();
    // Using a different, more standard GLB model to ensure compatibility
    loader.load(
        'https://threejs.org/examples/models/gltf/LeePerrySmith/LeePerrySmith.glb',
        (gltf) => {
            faceMesh = gltf.scene;
            const skinTexture = new THREE.TextureLoader().load('skin.png');
            skinTexture.wrapS = THREE.RepeatWrapping;
            skinTexture.wrapT = THREE.RepeatWrapping;
            skinTexture.repeat.set(4, 4);

            const material = new THREE.MeshStandardMaterial({
                map: skinTexture,
                roughness: 0.6,
                metalness: 0.1,
            });

            faceMesh.traverse((child) => {
                if (child.isMesh) {
                    child.material = material;
                    // Flag the face mesh to distinguish from pimples
                    child.userData.isFace = true; 
                    // Store vertex data for pimple placement
                    child.geometry.computeVertexNormals();
                    child.geometry.setAttribute('initialPosition', child.geometry.attributes.position.clone());
                }
            });
            
            faceMesh.scale.set(0.7, 0.7, 0.7);
            faceMesh.position.y = -0.5;
            scene.add(faceMesh);
            loadingOverlay.style.display = 'none';
            startGame();
        },
        undefined,
        (error) => {
            console.error('An error happened while loading the model:', error);
            loadingOverlay.textContent = "Error loading model. Please refresh.";
        }
    );
}

function onWindowResize() {
    const gameRect = gameArea.getBoundingClientRect();
    if (gameRect.width > 0 && gameRect.height > 0) {
        camera.aspect = gameRect.width / gameRect.height;
        camera.updateProjectionMatrix();
        renderer.setSize(gameRect.width, gameRect.height);
    }
}

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
    if (!faceMesh || pimples.length >= MAX_PIMPLES) return;

    let targetMesh;
    // Traverse to find only the face mesh, not other pimples.
    faceMesh.traverse(child => { if(child.isMesh && child.userData.isFace) targetMesh = child; });
    if(!targetMesh) {
        console.error("Could not find face mesh to spawn pimple on.");
        return;
    }

    const positionAttribute = targetMesh.geometry.getAttribute('initialPosition');
    if (!positionAttribute) {
        console.error("Face mesh is missing 'initialPosition' attribute.");
        return;
    }
    const vertexIndex = Math.floor(Math.random() * positionAttribute.count);
    
    const pimplePosition = new THREE.Vector3().fromBufferAttribute(positionAttribute, vertexIndex);
    
    const pimpleSize = Math.random() * 0.03 + 0.04;
    const geometry = new THREE.SphereGeometry(pimpleSize, 16, 16);
    const material = new THREE.MeshPhongMaterial({ color: 0xff6b81, shininess: 80 });
    const pimpleMesh = new THREE.Mesh(geometry, material);

    pimpleMesh.position.copy(pimplePosition);
    pimpleMesh.userData.isPimple = true;
    pimpleMesh.userData.popped = false;

    faceMesh.add(pimpleMesh);
    pimples.push(pimpleMesh);
}

function onCanvasClick(event) {
    // Basic debounce to prevent click firing immediately after drag
    if (controls.isDragging) return;

    const gameRect = gameArea.getBoundingClientRect();
    mouse.x = ((event.clientX - gameRect.left) / gameRect.width) * 2 - 1;
    mouse.y = -((event.clientY - gameRect.top) / gameRect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    for (const intersect of intersects) {
        if (intersect.object.userData.isPimple && !intersect.object.userData.popped) {
            popPimple(intersect.object);
            break; 
        }
    }
}

function popPimple(pimpleMesh) {
    if (pimpleMesh.userData.popped) return;

    playPopSound();
    
    pimpleMesh.userData.popped = true;

    score++;
    scoreEl.textContent = score;

    // Confetti
    const screenPos = toScreenPosition(pimpleMesh, camera);
    confetti({
        particleCount: Math.floor(Math.random() * 20 + 30),
        spread: 70,
        angle: Math.random() * 360,
        startVelocity: 25,
        origin: { x: screenPos.x, y: screenPos.y },
        colors: ['#FFFF00', '#FFFACD', '#FAFAD2', '#FFFFFF'],
        scalar: Math.random() * 0.5 + 0.75
    });

    // Animate pop
    pimpleMesh.material.color.set(0x5a2d2d);
    pimpleMesh.material.transparent = true;
    let opacity = 1;
    const fade = () => {
        opacity -= 0.05;
        if (opacity <= 0) {
            faceMesh.remove(pimpleMesh);
            const index = pimples.indexOf(pimpleMesh);
            if (index > -1) pimples.splice(index, 1);
        } else {
            pimpleMesh.material.opacity = opacity;
            requestAnimationFrame(fade);
        }
    };
    setTimeout(fade, 100);
}

function toScreenPosition(obj, camera) {
    const vector = new THREE.Vector3();
    obj.getWorldPosition(vector);
    vector.project(camera);

    const gameRect = gameArea.getBoundingClientRect();
    vector.x = (vector.x * 0.5 + 0.5) * gameRect.width + gameRect.left;
    vector.y = (vector.y * -0.5 + 0.5) * gameRect.height + gameRect.top;

    return {
        x: vector.x / window.innerWidth,
        y: vector.y / window.innerHeight
    };
}

// --- Game Initialization ---
function startGame() {
    // Initial audio setup requires user interaction
    document.body.addEventListener('click', initializeAudio, { once: true });
    
    score = 0;
    scoreEl.textContent = score;
    
    // Clear any previous pimples
    pimples.forEach(p => faceMesh.remove(p));
    pimples.length = 0;

    // Initial burst of pimples
    for(let i=0; i<8; i++) {
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

function animate() {
    requestAnimationFrame(animate);
    if(controls) controls.update(); // update controls on each frame
    renderer.render(scene, camera);
}

init3D();
animate();