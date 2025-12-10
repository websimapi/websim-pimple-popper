import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Configuration ---
const CONFIG = {
    MAX_PIMPLES: 10,
    MAX_HAIRS: 8,
    SQUEEZE_TIME: 800, // ms to fully squeeze
    HAIR_PULL_THRESHOLD: 0.25, // World units - Longer pull needed
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
        this.squeezeFactor = 0;

        this.group = new THREE.Group();
        this.group.position.copy(position);
        this.group.lookAt(position.clone().add(normal));

        // Scale variation
        this.group.scale.setScalar(0.8 + Math.random() * 0.4);

        // 1. Inflamed Base (Smoother blending)
        const baseGeo = new THREE.SphereGeometry(0.08, 16, 16);
        baseGeo.scale(1, 1, 0.3); // Flatten
        const baseMat = new THREE.MeshStandardMaterial({ 
            color: 0xff5e5e, 
            roughness: 0.4,
            metalness: 0.1
        });
        this.base = new THREE.Mesh(baseGeo, baseMat);
        this.base.position.z = 0.005; 
        this.group.add(this.base);

        // 2. The Head (Pus)
        const headGeo = new THREE.SphereGeometry(0.035, 16, 16);
        headGeo.scale(1, 1, 0.8);
        const headMat = new THREE.MeshStandardMaterial({ 
            color: 0xfffdd0, 
            roughness: 0.1, // Shiny / Oily
            metalness: 0.1,
            emissive: 0x222211,
            emissiveIntensity: 0.1
        });
        this.head = new THREE.Mesh(headGeo, headMat);
        this.head.position.z = 0.025;
        this.group.add(this.head);

        // 3. Collider
        const colliderGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        this.collider = new THREE.Mesh(colliderGeo, colliderMat);
        this.group.add(this.collider);
        
        this.collider.userData.entity = this;
        faceGroup.add(this.group);
    }

    update(dt) {
        if (this.isPopped) return;

        if (this.squeezeFactor === 0) {
            // Idle throb
            const s = 1 + Math.sin(Date.now() * 0.002) * 0.03;
            this.head.scale.set(s, s, 0.8 * s);
        } else {
            // Squeeze Feedback
            const f = this.squeezeFactor;
            
            // Base widens and gets angrier red
            this.base.scale.set(1 + f*0.4, 1 + f*0.4, 0.3 - f*0.1);
            this.base.material.color.setHSL(0.0, 0.8, 0.6 - f*0.2);

            // Head bulges out significantly
            const headScale = 1 + f * 0.8;
            this.head.scale.set(headScale, headScale, 0.8 + f * 1.0);
            this.head.position.z = 0.025 + f * 0.04;
        }
    }

    pop() {
        this.isPopped = true;
        this.group.remove(this.head);
        this.group.remove(this.collider);
        
        // Visual Aftermath: Crater
        const craterGeo = new THREE.CircleGeometry(0.04, 12);
        const craterMat = new THREE.MeshStandardMaterial({ 
            color: 0x3d0000, 
            roughness: 0.8, 
            side: THREE.DoubleSide 
        });
        const crater = new THREE.Mesh(craterGeo, craterMat);
        crater.position.z = 0.01;
        this.group.add(crater);

        // Shrink inflammation
        this.base.scale.set(0.8, 0.8, 0.1);
        this.base.material.color.setHex(0xaa4444);

        playSound(popBuffer, 0.8 + Math.random() * 0.4);
        spawnParticles(this.group.position, this.normal, 'pus');
        splatScreen();
        addScore(100);
        triggerHaptic();

        // Cleanup
        setTimeout(() => {
            if(faceGroup) faceGroup.remove(this.group);
            const idx = gameObjects.indexOf(this);
            if (idx > -1) gameObjects.splice(idx, 1);
        }, 8000);
    }
}

class IngrownHair {
    constructor(position, normal) {
        this.type = 'hair';
        this.position = position;
        this.normal = normal;
        this.isPlucked = false;

        this.group = new THREE.Group();
        this.group.position.copy(position);
        
        // Align Y axis to normal
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        this.group.setRotationFromQuaternion(q);
        // Random spin around normal
        this.group.rotateY(Math.random() * Math.PI * 2);

        // 1. Inflamed Pore (Bump)
        const bumpGeo = new THREE.CylinderGeometry(0.03, 0.05, 0.015, 12);
        const bumpMat = new THREE.MeshStandardMaterial({ color: 0xd65555, roughness: 0.5 });
        this.bump = new THREE.Mesh(bumpGeo, bumpMat);
        this.bump.position.y = 0.005;
        this.group.add(this.bump);

        // 2. Pore opening (Dark spot)
        const poreGeo = new THREE.CircleGeometry(0.01, 8);
        const poreMat = new THREE.MeshStandardMaterial({ color: 0x1a0a0a, roughness: 1.0 });
        this.pore = new THREE.Mesh(poreGeo, poreMat);
        this.pore.position.y = 0.013;
        this.pore.rotation.x = -Math.PI / 2;
        this.group.add(this.pore);

        // 3. Hair (Mesh)
        // Using a cylinder that we stretch.
        const hairGeo = new THREE.CylinderGeometry(0.003, 0.003, 1, 5);
        hairGeo.translate(0, 0.5, 0); // Pivot at base (0,0,0)
        const hairMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
        this.hairMesh = new THREE.Mesh(hairGeo, hairMat);
        this.hairMesh.scale.set(1, 0.03, 1); // Start short (stub)
        
        // We wrap hairMesh in a pivot group so we can rotate it without messing up geometry transform
        this.hairPivot = new THREE.Group();
        this.hairPivot.add(this.hairMesh);
        this.group.add(this.hairPivot);

        // Collider
        const colliderGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.15);
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        this.collider = new THREE.Mesh(colliderGeo, colliderMat);
        this.collider.position.y = 0.07;
        this.collider.userData.entity = this;
        this.group.add(this.collider);

        faceGroup.add(this.group);
    }

    updateDrag(rayPoint) {
        // rayPoint in World Space
        const localPoint = this.group.worldToLocal(rayPoint.clone());
        localPoint.y = Math.max(0.01, localPoint.y);

        const len = localPoint.length();
        
        // Stretch visual
        // Limit stretch so it doesn't look infinite if bugged
        const visualLen = Math.min(len, 2.0);
        this.hairMesh.scale.set(1, visualLen, 1);
        
        // Point at cursor
        const up = new THREE.Vector3(0, 1, 0);
        const targetDir = localPoint.normalize();
        this.hairPivot.quaternion.setFromUnitVectors(up, targetDir);

        return len;
    }

    pluck() {
        this.isPlucked = true;
        faceGroup.remove(this.group);
        
        playSound(pluckBuffer, 1.0 + Math.random() * 0.5);
        
        // Pass the final orientation to the particle spawner so it aligns
        // Convert local pivot rotation to world
        const worldQuat = new THREE.Quaternion();
        this.hairPivot.getWorldQuaternion(worldQuat);
        
        spawnParticles(this.group.position, worldQuat, 'hair_pluck'); 
        addScore(150);
        triggerHaptic();

        const idx = gameObjects.indexOf(this);
        if (idx > -1) gameObjects.splice(idx, 1);
    }

    reset() {
        this.hairMesh.scale.set(1, 0.03, 1);
        this.hairPivot.quaternion.identity();
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
        if (obj.position.distanceTo(pos) < 0.18) return; // Increased spacing for separation
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

function spawnParticles(pos, rotationOrNormal, type) {
    if (type === 'pus') {
        // Debris burst
        const normal = rotationOrNormal;
        const count = 12;
        const cols = [0xfffdd0, 0xffeb3b, 0xffffff];
        
        for(let i=0; i<count; i++) {
            const col = cols[Math.floor(Math.random() * cols.length)];
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(Math.random() * 0.015 + 0.005, 4, 4),
                new THREE.MeshStandardMaterial({ color: col, roughness: 0.1, metalness: 0.1 })
            );
            
            mesh.position.copy(pos).add(normal.clone().multiplyScalar(0.02));
            
            // Cone spray
            const sprayDir = normal.clone().add(
                new THREE.Vector3((Math.random()-0.5)*0.8, (Math.random()-0.5)*0.8, (Math.random()-0.5)*0.8)
            ).normalize();
            
            const vel = sprayDir.multiplyScalar(Math.random() * 0.15 + 0.05);

            scene.add(mesh);
            particles.push({ mesh, vel, type: 'pus', life: 0.8 + Math.random()*0.4 });
        }
    } else if (type === 'hair_pluck') {
        // The curled hair flying away with root
        const quat = rotationOrNormal; // It's a quaternion passed from IngrownHair

        const group = new THREE.Group();
        group.position.copy(pos);
        group.quaternion.copy(quat);

        // Recreate the hair visual but with a bulb
        const hairGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.25, 5); // Fixed length for the loose hair
        hairGeo.translate(0, 0.125, 0); // Center it
        const hairMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a });
        const hair = new THREE.Mesh(hairGeo, hairMat);
        
        // Add random bend/curl visual
        hair.rotation.z = (Math.random() - 0.5) * 0.5;

        // Bulb
        const bulb = new THREE.Mesh(
            new THREE.SphereGeometry(0.008, 6, 6),
            new THREE.MeshStandardMaterial({ color: 0xffffff })
        );
        bulb.position.y = 0; // At the bottom
        hair.add(bulb);
        
        group.add(hair);
        
        // Initial velocity is roughly along the hair's UP vector
        const flyDir = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
        const vel = flyDir.multiplyScalar(0.2);

        scene.add(group);
        particles.push({ 
            mesh: group, 
            vel, 
            type: 'hair', 
            life: 2.0, 
            rot: new THREE.Vector3(Math.random()*0.1, Math.random()*0.1, Math.random()*0.1) 
        });
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

