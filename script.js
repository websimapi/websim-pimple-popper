import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Configuration ---
const CONFIG = {
    MAX_PIMPLES: 12,
    MAX_HAIRS: 6,
    SQUEEZE_TIME: 800, // ms to fully squeeze
    HAIR_PULL_THRESHOLD: 0.15, // World units
    COMBO_WINDOW: 2000, // ms
    GRAVITY: -9.8
};

// --- Globals ---
const gameArea = document.getElementById('game-area');
const scoreEl = document.getElementById('score');
const comboContainer = document.getElementById('combo-container');
const comboCountEl = document.getElementById('combo-count');
const splatCanvas = document.getElementById('splat-canvas');
const instructions = document.getElementById('instructions');
const splatCtx = splatCanvas.getContext('2d');

let scene, camera, renderer, controls, raycaster;
let faceMesh, faceGroup;
let audioContext;
let popBuffer, pluckBuffer;
let lastTime = 0;

// Game State
let score = 0;
let combo = 0;
let comboTimer = null;
let activeInteraction = null; // { type: 'squeeze'|'pluck', object: ..., start: ... }
let particles = [];
let gameObjects = []; // Stores custom wrappers for pimples/hairs

// --- Audio ---
async function initAudio() {
    if (audioContext) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContext();

    const loadSound = async (url) => {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        return await audioContext.decodeAudioData(buf);
    };

    [popBuffer, pluckBuffer] = await Promise.all([
        loadSound('pop.mp3'),
        loadSound('pluck.mp3')
    ]);
}

function playSound(buffer, pitch = 1.0, volume = 1.0) {
    if (!audioContext || !buffer) return;
    if (audioContext.state === 'suspended') audioContext.resume();

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;
    
    const gainNode = audioContext.createGain();
    gainNode.gain.value = volume;

    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(0);
}

// --- 3D Scene Setup ---
function init() {
    // Canvas sizing
    splatCanvas.width = window.innerWidth;
    splatCanvas.height = window.innerHeight;

    scene = new THREE.Scene();
    
    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 3.5);

    // Renderer
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance
    renderer.physicallyCorrectLights = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    gameArea.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enablePan = false;
    controls.minDistance = 2.0;
    controls.maxDistance = 5.0;
    controls.rotateSpeed = 0.7;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffeebb, 0.4);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.5);
    mainLight.position.set(5, 5, 5);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 1024;
    mainLight.shadow.mapSize.height = 1024;
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0xffdca4, 0.5);
    fillLight.position.set(-5, 0, 2);
    scene.add(fillLight);

    // Headlamp (Follows camera)
    const headLamp = new THREE.SpotLight(0xffffff, 2.0);
    headLamp.position.set(0, 0, 0); // At camera
    headLamp.angle = Math.PI / 6;
    headLamp.penumbra = 0.5;
    headLamp.decay = 2;
    headLamp.distance = 10;
    camera.add(headLamp);
    scene.add(camera);

    raycaster = new THREE.Raycaster();

    // Interaction Events
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
    
    window.addEventListener('resize', onResize);

    loadModel();
}

function loadModel() {
    const loader = new GLTFLoader();
    loader.load('https://threejs.org/examples/models/gltf/LeePerrySmith/LeePerrySmith.glb', (gltf) => {
        const mesh = gltf.scene.children[0];
        
        // Better skin material
        const texLoader = new THREE.TextureLoader();
        const skinTex = texLoader.load('skin.png');
        skinTex.wrapS = THREE.RepeatWrapping;
        skinTex.wrapT = THREE.RepeatWrapping;
        skinTex.repeat.set(6, 6);
        skinTex.encoding = THREE.sRGBEncoding;

        const material = new THREE.MeshStandardMaterial({
            map: skinTex,
            color: 0xffe0bd,
            roughness: 0.5,
            metalness: 0.0,
            normalScale: new THREE.Vector2(0.5, 0.5)
        });

        mesh.material = material;
        mesh.geometry.computeVertexNormals();
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        
        // Save initial positions for spawning
        mesh.geometry.setAttribute('initialPos', mesh.geometry.attributes.position.clone());
        mesh.geometry.setAttribute('initialNorm', mesh.geometry.attributes.normal.clone());

        faceMesh = mesh;
        faceGroup = new THREE.Group();
        faceGroup.add(faceMesh);
        
        // Center and scale
        faceGroup.scale.set(0.6, 0.6, 0.6);
        faceGroup.position.y = -0.3;
        
        scene.add(faceGroup);

        document.getElementById('loading-overlay').style.opacity = 0;
        setTimeout(() => document.getElementById('loading-overlay').style.display = 'none', 500);

        startGame();
    });
}

// --- Entities ---

class Pimple {
    constructor(position, normal) {
        this.type = 'pimple';
        this.position = position;
        this.normal = normal;
        this.isPopped = false;
        this.squeezeStart = 0;
        this.squeezeFactor = 0;

        // Visuals
        this.group = new THREE.Group();
        this.group.position.copy(position);
        this.group.lookAt(position.clone().add(normal));

        // Base (Red swelling)
        const baseGeo = new THREE.SphereGeometry(0.06, 16, 8);
        baseGeo.scale(1, 0.3, 1);
        const baseMat = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.3 });
        this.base = new THREE.Mesh(baseGeo, baseMat);
        this.base.position.z = 0.01;
        this.group.add(this.base);

        // Head (White pus)
        const headGeo = new THREE.SphereGeometry(0.025, 12, 8);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xfffae6, roughness: 0.1, metalness: 0.1 });
        this.head = new THREE.Mesh(headGeo, headMat);
        this.head.position.z = 0.03;
        this.group.add(this.head);

        // Add hidden collider for easier clicking
        const colliderGeo = new THREE.SphereGeometry(0.08, 8, 8);
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        this.collider = new THREE.Mesh(colliderGeo, colliderMat);
        this.group.add(this.collider);
        
        // Link wrapper to mesh for raycasting
        this.collider.userData.entity = this;

        faceGroup.add(this.group);
    }

    update(dt) {
        if (this.isPopped) return;

        // Visual throbbing if untouched
        if (this.squeezeFactor === 0) {
            const scale = 1 + Math.sin(Date.now() * 0.003) * 0.05;
            this.head.scale.setScalar(scale);
        } else {
            // Squeeze deformation
            // Base spreads out, Head bulges out
            const baseScale = 1 + this.squeezeFactor * 0.5; // wider
            const headBulge = 1 + this.squeezeFactor * 1.5; // bigger
            const headZ = 0.03 + this.squeezeFactor * 0.04; // pushes out

            this.base.scale.set(baseScale, 0.3, baseScale);
            this.base.material.color.setHSL(0.99, 0.8, 0.6 - this.squeezeFactor * 0.2); // gets redder
            
            this.head.scale.setScalar(headBulge);
            this.head.position.z = headZ;
            
            // Shake effect handled in loop
        }
    }

    pop() {
        this.isPopped = true;
        this.group.remove(this.head);
        this.group.remove(this.collider);
        
        // Crater effect
        this.base.geometry = new THREE.RingGeometry(0.01, 0.05, 16);
        this.base.material.color.setHex(0x5a2d2d); // dark red
        this.base.scale.set(1, 1, 1);
        this.base.position.z = 0.005;

        playSound(popBuffer, 0.8 + Math.random() * 0.4);
        spawnParticles(this.group.position, this.normal, 'pus');
        splatScreen();
        addScore(100);
        triggerHaptic();

        // Remove after delay
        setTimeout(() => {
            if(faceGroup) faceGroup.remove(this.group);
            const idx = gameObjects.indexOf(this);
            if (idx > -1) gameObjects.splice(idx, 1);
        }, 5000);
    }
}

class IngrownHair {
    constructor(position, normal) {
        this.type = 'hair';
        this.position = position;
        this.normal = normal;
        this.restLength = 0.15; // Visual length (mostly under skin)
        this.pullLength = 0;
        this.isPlucked = false;

        this.group = new THREE.Group();
        this.group.position.copy(position);
        
        // Align Y axis to normal
        this.quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        this.group.setRotationFromQuaternion(this.quaternion);

        // Visual bump
        const bumpGeo = new THREE.SphereGeometry(0.02, 8, 8);
        bumpGeo.scale(1, 0.5, 1);
        const bumpMat = new THREE.MeshStandardMaterial({ color: 0xd69d85 });
        this.bump = new THREE.Mesh(bumpGeo, bumpMat);
        this.group.add(this.bump);

        // Hair Mesh (Pivot at bottom)
        const hairGeo = new THREE.CylinderGeometry(0.002, 0.002, 1, 5);
        hairGeo.translate(0, 0.5, 0); // Anchor at base
        const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
        this.hairMesh = new THREE.Mesh(hairGeo, hairMat);
        this.hairMesh.scale.set(1, 0.02, 1); // Just a tiny nub visible initially
        this.group.add(this.hairMesh);

        // Collider
        const colliderGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.1);
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        this.collider = new THREE.Mesh(colliderGeo, colliderMat);
        this.collider.position.y = 0.05;
        this.collider.userData.entity = this;
        this.group.add(this.collider);

        faceGroup.add(this.group);
    }

    updateDrag(rayPoint) {
        // rayPoint is in world space.
        // Convert to local space of the hair group (where Y is up/normal)
        const localPoint = this.group.worldToLocal(rayPoint.clone());
        
        // We only care about pulling "Up" (positive Y) and maybe some bend (X/Z)
        // Clamp Y to not go below surface
        localPoint.y = Math.max(0.01, localPoint.y);

        // The hair vector is from (0,0,0) to localPoint
        const len = localPoint.length();
        
        // Visual Stretch
        this.hairMesh.scale.set(1, len, 1);
        
        // Orientation: point at cursor
        const up = new THREE.Vector3(0, 1, 0);
        const targetDir = localPoint.normalize();
        this.hairMesh.quaternion.setFromUnitVectors(up, targetDir);

        return len; // Return drag distance
    }

    pluck() {
        this.isPlucked = true;
        faceGroup.remove(this.group);
        
        playSound(pluckBuffer, 1.0 + Math.random() * 0.5);
        spawnParticles(this.group.position, this.normal, 'hair'); // Spawns the loose hair
        addScore(150);
        triggerHaptic();

        const idx = gameObjects.indexOf(this);
        if (idx > -1) gameObjects.splice(idx, 1);
    }

    reset() {
        // Snap back animation could go here
        this.hairMesh.scale.set(1, 0.02, 1);
        this.hairMesh.quaternion.identity();
    }
}

// --- Interaction Logic ---

function onPointerDown(event) {
    if (activeInteraction) return; // Already busy
    initAudio();

    // hide instructions on first interaction
    instructions.classList.add('fade-out');

    const coords = getNormalizedCoords(event);
    raycaster.setFromCamera(coords, camera);

    // Get all colliders
    const colliders = [];
    gameObjects.forEach(obj => {
        if (obj.collider) colliders.push(obj.collider);
    });

    const intersects = raycaster.intersectObjects(colliders, false);

    if (intersects.length > 0) {
        const entity = intersects[0].object.userData.entity;
        
        if (entity.type === 'pimple') {
            startSqueeze(entity);
        } else if (entity.type === 'hair') {
            startPluck(entity, event);
        }
    }
}

function startSqueeze(pimple) {
    controls.enabled = false;
    activeInteraction = {
        type: 'squeeze',
        object: pimple,
        startTime: Date.now()
    };
    document.body.style.cursor = "crosshair";
}

function startPluck(hair, event) {
    controls.enabled = false;
    
    // Create a drag plane at the hair's position facing the camera
    const planeNormal = camera.position.clone().sub(hair.group.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, hair.group.position);

    activeInteraction = {
        type: 'pluck',
        object: hair,
        plane: plane
    };
    document.body.style.cursor = "grabbing";
}

function onPointerMove(event) {
    if (!activeInteraction) return;

    if (activeInteraction.type === 'pluck') {
        const coords = getNormalizedCoords(event);
        raycaster.setFromCamera(coords, camera);
        
        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(activeInteraction.plane, intersectPoint);

        if (intersectPoint) {
            const dragDist = activeInteraction.object.updateDrag(intersectPoint);
            
            // Check if pulled far enough
            if (dragDist > CONFIG.HAIR_PULL_THRESHOLD) {
                activeInteraction.object.pluck();
                endInteraction();
            }
        }
    }
}

function onPointerUp() {
    if (!activeInteraction) return;

    if (activeInteraction.type === 'squeeze') {
        const dur = Date.now() - activeInteraction.startTime;
        const progress = Math.min(dur / CONFIG.SQUEEZE_TIME, 1.2); // allow over-squeeze

        if (progress >= 0.8 && progress <= 1.1) {
            // Perfect pop
            activeInteraction.object.pop();
        } else if (progress > 1.1) {
             // Over squeezed - pop but painful (less score or just visual mess)
             activeInteraction.object.pop(); // Still pop, maybe add "pain" sound later
        } else {
            // Fizzle
            activeInteraction.object.squeezeFactor = 0; // Reset
            activeInteraction.object.update();
        }
    } else if (activeInteraction.type === 'pluck') {
        // Released too early
        activeInteraction.object.reset();
    }

    endInteraction();
}

function endInteraction() {
    activeInteraction = null;
    document.body.style.cursor = "default";
    // Crucial: Controls remain disabled until the NEXT user gesture start, 
    // but OrbitControls.enabled = true allows it to catch the next 'down' event.
    // However, to prevent "spinning" immediately after release if the mouse is moving:
    controls.enabled = true;
    // We reset any damping momentum
    controls.update(); 
}

function getNormalizedCoords(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    return {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((event.clientY - rect.top) / rect.height) * 2 + 1
    };
}

// --- Gameplay Systems ---

function addScore(points) {
    // Combo Logic
    const now = Date.now();
    if (now - comboTimer < CONFIG.COMBO_WINDOW) {
        combo++;
    } else {
        combo = 1;
    }
    comboTimer = now;

    // Visuals
    const total = points * combo;
    score += total;
    
    // UI Updates
    scoreEl.innerText = score.toLocaleString();
    scoreEl.classList.remove('shake');
    void scoreEl.offsetWidth; // trigger reflow
    scoreEl.classList.add('shake');

    if (combo > 1) {
        comboCountEl.innerText = `x${combo}`;
        comboContainer.classList.remove('hidden');
        
        // Hide combo after delay
        clearTimeout(window.comboHideTimeout);
        window.comboHideTimeout = setTimeout(() => {
            comboContainer.classList.add('hidden');
        }, CONFIG.COMBO_WINDOW);
    }
}

function spawnEntity() {
    if (!faceMesh) return;

    const positions = faceMesh.geometry.attributes.initialPos;
    const normals = faceMesh.geometry.attributes.initialNorm;
    
    // Pick random vertex
    const idx = Math.floor(Math.random() * positions.count);
    const pos = new THREE.Vector3().fromBufferAttribute(positions, idx);
    const norm = new THREE.Vector3().fromBufferAttribute(normals, idx);

    // Basic collision check (too close to others?)
    for (let obj of gameObjects) {
        if (obj.position.distanceTo(pos) < 0.1) return; // Too close, try again next frame
    }

    const isHair = Math.random() > 0.6;
    const currentHairs = gameObjects.filter(o => o.type === 'hair').length;
    const currentPimples = gameObjects.filter(o => o.type === 'pimple').length;

    if (isHair && currentHairs < CONFIG.MAX_HAIRS) {
        gameObjects.push(new IngrownHair(pos, norm));
    } else if (!isHair && currentPimples < CONFIG.MAX_PIMPLES) {
        gameObjects.push(new Pimple(pos, norm));
    }
}

// --- FX ---

function spawnParticles(pos, normal, type) {
    if (type === 'pus') {
        // Burst of yellow goo
        const count = 15;
        for(let i=0; i<count; i++) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(Math.random() * 0.01 + 0.005, 4, 4),
                new THREE.MeshStandardMaterial({ color: 0xfffdd0, roughness: 0.2 })
            );
            
            // Offset slightly from surface
            mesh.position.copy(pos).add(normal.clone().multiplyScalar(0.02));
            
            // Random velocity outward
            const vel = normal.clone().add(
                new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5)
            ).normalize().multiplyScalar(Math.random() * 0.1 + 0.05);

            scene.add(mesh);
            particles.push({ mesh, vel, type: 'pus', life: 1.0 });
        }
    } else if (type === 'hair') {
        // The singular hair flying away
        const geometry = new THREE.CylinderGeometry(0.002, 0.002, 0.2, 3);
        const material = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(pos);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), normal);
        
        const vel = normal.clone().multiplyScalar(0.2);
        
        scene.add(mesh);
        particles.push({ mesh, vel, type: 'hair', life: 1.5, rot: new THREE.Vector3(Math.random(), Math.random(), Math.random()) });
    }
}

function splatScreen() {
    // Draw a random splat on the 2D canvas
    const x = Math.random() * splatCanvas.width;
    const y = Math.random() * splatCanvas.height;
    const size = Math.random() * 50 + 20;

    splatCtx.fillStyle = `rgba(255, 255, 230, ${Math.random() * 0.5 + 0.3})`;
    splatCtx.beginPath();
    splatCtx.arc(x, y, size, 0, Math.PI * 2);
    splatCtx.fill();

    // Drips
    splatCtx.beginPath();
    splatCtx.arc(x + (Math.random()-0.5)*20, y + 20, size*0.6, 0, Math.PI * 2);
    splatCtx.fill();

    // Fade out canvas over time (done in animate)
}

function triggerHaptic() {
    if (navigator.vibrate) navigator.vibrate(50);
}

// --- Loop ---

function startGame() {
    // Initial spawn
    for(let i=0; i<5; i++) spawnEntity();
    animate();
}

function animate() {
    requestAnimationFrame(animate);

    const now = Date.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // Spawning Logic
    if (Math.random() < 0.02) spawnEntity();

    // Interaction Update
    if (activeInteraction && activeInteraction.type === 'squeeze') {
        const dur = now - activeInteraction.startTime;
        const factor = Math.min(dur / CONFIG.SQUEEZE_TIME, 1.3);
        activeInteraction.object.squeezeFactor = factor;
        activeInteraction.object.update();
        
        // Shake camera slightly as tension builds
        if (factor > 0.5) {
            const intensity = (factor - 0.5) * 0.01;
            camera.position.x += (Math.random() - 0.5) * intensity;
            camera.position.y += (Math.random() - 0.5) * intensity;
        }
    }

    // Particle Physics
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        
        // Move
        p.mesh.position.add(p.vel);
        
        if (p.type === 'pus') {
            p.vel.y += CONFIG.GRAVITY * dt * 0.1; // Gravity
            p.mesh.scale.setScalar(p.life); // Shrink
        } else if (p.type === 'hair') {
            p.vel.y += CONFIG.GRAVITY * dt * 0.05;
            p.mesh.rotation.x += p.rot.x;
            p.mesh.rotation.y += p.rot.y;
        }

        if (p.life <= 0) {
            scene.remove(p.mesh);
            particles.splice(i, 1);
        }
    }

    // Fade Splat Canvas
    if (Math.random() < 0.1) {
        splatCtx.globalCompositeOperation = 'destination-out';
        splatCtx.fillStyle = 'rgba(0, 0, 0, 0.02)';
        splatCtx.fillRect(0, 0, splatCanvas.width, splatCanvas.height);
        splatCtx.globalCompositeOperation = 'source-over';
    }

    // Controls update (only if enabled)
    if (controls.enabled) controls.update();

    renderer.render(scene, camera);
}

// Handle Resize
function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    splatCanvas.width = window.innerWidth;
    splatCanvas.height = window.innerHeight;
}

init();

