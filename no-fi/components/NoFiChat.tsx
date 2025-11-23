import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Signal, WifiOff, Repeat, Activity, Lock, Loader2 } from 'lucide-react';
// import { pipeline } from '@xenova/transformers';

interface Message {
  id: number;
  text: string;
  sender: 'me' | 'other' | 'system';
  timestamp: Date;
}

interface Log {
  message: string;
  type: 'info' | 'success' | 'error';
  timestamp: string;
}

// -- AUDIO PROTOCOL CONSTANTS --
// Simple Frequency Shift Keying (FSK) / Marker-based protocol
// const PROTOCOL = {
//   MARKER_FREQ: 1200,      // Signal start/separator tone (Hz)
//   BASE_FREQ: 1500,        // Starting frequency for data (Hz)
//   STEP_FREQ: 40,          // Hz per ASCII code
//   TONE_DURATION: 0.08,    // Duration of each tone (seconds)
//   GAP_DURATION: 0.02,     // Silence between tones
//   FFT_SIZE: 2048,
//   THRESHOLD: 30,          // Min decibel level to detect
//   SILENCE_TIMEOUT: 1500,  // Time to wait before considering message complete (ms)
// };

// -- AUDIO PROTOCOL CONSTANTS --
// -- AUDIO PROTOCOL CONSTANTS --
// -- AUDIO PROTOCOL CONSTANTS --
// -- AUDIO PROTOCOL CONSTANTS (TUNED) --
const PROTOCOL = {
  // Physics
  FFT_SIZE: 2048,
  THRESHOLD: 20,
  RANGE: 100,             
  
  // Timing
  TONE_DURATION: 0.25,
  GAP_DURATION: 0.05,
  SILENCE_TIMEOUT: 2000,
  
  // Frequencies
  STEP_FREQ: 100,         // Keep 100 for Audible (Reliability)
  
  // Modes
  MODES: {
    AUDIBLE: { 
        MARKER: 1000, 
        BASE: 1400 
    }, 
    STEALTH: { 
        MARKER: 16000,    // Lowered to fit in bandwidth
        BASE: 16500,      // Start data at 16.5kHz
        STEP_FREQ: 40     // Tighten step to 40Hz to fit all letters under 21kHz
    }
  }
};

const NoFiChat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: 1, text: "Welcome to NoFi! Messages are now transmitted via REAL audio tones.", sender: "system", timestamp: new Date() }
  ]);
  const [inputText, setInputText] = useState<string>('');
  const [logs, setLogs] = useState<Log[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(true);
  const [micPermission, setMicPermission] = useState<boolean>(false);
  const [isSecureContext, setIsSecureContext] = useState<boolean>(true);
  
  // Transmission States
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isReceiving, setIsReceiving] = useState<boolean>(false);
  const [incomingBuffer, setIncomingBuffer] = useState<string>('');
  
  // Background Process States
  const [isRelaying, setIsRelaying] = useState<boolean>(false);
  const [relayCount, setRelayCount] = useState<number>(0);
  
  const [signalStrength, setSignalStrength] = useState<number>(0);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // -- OFFLINE AI STATE --
  // const [transcriber, setTranscriber] = useState<any>(null);
  // const [isModelLoading, setIsModelLoading] = useState<boolean>(false);
  // ... inside NoFiChat component ...

  // -- OFFLINE AI STATE --
  const [transcriber, setTranscriber] = useState<any>(null);
  const [isModelLoading, setIsModelLoading] = useState<boolean>(true); // Start true to load immediately
  const [isRecordingAI, setIsRecordingAI] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // 1. Load the Model on Startup (One time)
  // useEffect(() => {
  //   const loadModel = async () => {
  //     setIsModelLoading(true);
  //     try {
  //       // 'task' is automatic-speech-recognition
  //       // 'model' is the quantized tiny version (small and fast)
  //       const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
  //       setTranscriber(() => pipe); // Store function in state
  //       addLog("Offline AI Voice Model Loaded", "success");
  //     } catch (err) {
  //       console.error(err);
  //       addLog("Failed to load Offline AI", "error");
  //     }
  //     setIsModelLoading(false);
  //   };
    
  //   // Trigger load only if user wants voice features (or auto-load)
  //   // For hackathon, maybe put a "Load Voice AI" button to save initial bandwidth
  //   // loadModel(); 
  // }, []);

  // // 2. Function to Transcribe Audio Blob
  // const transcribeAudio = async (audioBlob: Blob) => {
  //   if (!transcriber) {
  //       alert("AI Model not loaded yet!");
  //       return;
  //   }
    
  //   setIsDictating(true);
    
  //   // Convert Blob to URL for the model
  //   const url = URL.createObjectURL(audioBlob);
    
  //   try {
  //       const result = await transcriber(url);
  //       setInputText(prev => prev + " " + result.text);
  //   } catch (e) {
  //       console.error(e);
  //   }
    
  //   setIsDictating(false);
  // };

  // Decoder State
  const decoderRef = useRef({
    state: 'IDLE' as 'IDLE' | 'WAIT_MARKER' | 'READ_CHAR',
    buffer: '',
    lastDetectedChar: null as string | null,
    silenceTimer: null as number | null,
    consecutiveFrames: 0,
    lastFreqIndex: 0
  });

  // -- SYSTEM CHECKS (Tailwind & HTTPS) --
  useEffect(() => {
    // 1. Inject Tailwind CSS
    if (!document.querySelector('script[src*="tailwindcss"]')) {
      const script = document.createElement('script');
      script.src = "https://cdn.tailwindcss.com";
      script.async = true;
      document.head.appendChild(script);
    }

    // 2. Enforce HTTPS (Required for Microphone Access)
    // Browsers block getUserMedia on insecure origins (except localhost)
    if (
      window.location.protocol === 'http:' && 
      window.location.hostname !== 'localhost' && 
      window.location.hostname !== '127.0.0.1'
    ) {
      console.warn("NoFi requires a Secure Context. Redirecting to HTTPS...");
      window.location.href = window.location.href.replace(/^http:/, 'https:');
    }
    
    // Check if we are actually in a secure context (updates UI if failed)
    if (!window.isSecureContext) {
      setIsSecureContext(false);
      addLog('Error: App must run via HTTPS', 'error');
    }
  }, []);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, incomingBuffer]);

  // Background Process: Relay Logic
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];

    if (lastMessage && lastMessage.sender === 'other') {
      const processingDelay = Math.random() * 2000 + 1000;

      const timer = setTimeout(() => {
        setIsRelaying(true);
        addLog('Background: Relaying signal...', 'info');
        
        transmitAudio(lastMessage.text, () => {
          setIsRelaying(false);
          setRelayCount(prev => prev + 1);
          addLog(`Background: Packet relayed`, 'success');
        });

      }, processingDelay);

      return () => clearTimeout(timer);
    }
  }, [messages]);

  const addLog = (message: string, type: 'info' | 'success' | 'error' = 'info'): void => {
    const logEntry: Log = { message, type, timestamp: new Date().toLocaleTimeString() };
    setLogs(prev => [...prev.slice(-4), logEntry]);
  };

  const requestMicPermission = async (): Promise<void> => {
    if (!isSecureContext) {
      addLog('HTTPS required for Microphone', 'error');
      return;
    }

    try {
      // We need echo cancellation OFF for better raw frequency detection
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: false, 
          noiseSuppression: false, 
          autoGainControl: false 
        } 
      });
      
      mediaStreamRef.current = stream;
      setMicPermission(true);
      setShowOnboarding(false);
      addLog('Microphone access granted', 'success');
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
      
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = PROTOCOL.FFT_SIZE;
      analyserRef.current.smoothingTimeConstant = 0.2;
      
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      
      startAudioMonitoring();
    } catch (err) {
      addLog('Microphone access denied', 'error');
      console.error('Microphone error:', err);
    }
  };

  // -- TRANSMITTER --
  const transmitAudio = (text: string, onComplete?: () => void) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Use the Ref to determine mode
    const mode = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH : PROTOCOL.MODES.AUDIBLE;

    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now);
    
    let startTime = now + 0.1;

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      // Inside the for loop...
      const step = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH.STEP_FREQ : PROTOCOL.STEP_FREQ;
      const freq = mode.BASE + (charCode * step);
      // const freq = mode.BASE + (charCode * PROTOCOL.STEP_FREQ);

      // Marker Tone
      osc.frequency.setValueAtTime(mode.MARKER, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.01); 

      startTime += PROTOCOL.TONE_DURATION + PROTOCOL.GAP_DURATION;

      // Data Tone
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.01);

      startTime += PROTOCOL.TONE_DURATION + PROTOCOL.GAP_DURATION;
    }

    osc.start(now);
    osc.stop(startTime + 0.5);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      if (onComplete) onComplete();
    };
  };


  // -- RECEIVER LOOP --
  const startAudioMonitoring = (): void => {
    if (!analyserRef.current || !audioContextRef.current) return;
    
    // CRITICAL: Set FFT Size to match Protocol
    analyserRef.current.fftSize = PROTOCOL.FFT_SIZE;
    
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = audioContextRef.current;
    
    const update = (): void => {
      if (!analyserRef.current) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Visualizer (First 40 bins)
      setAudioLevel(dataArray[10] / 255 * 100); // Simple visualizer

      // FIND DOMINANT FREQUENCY
      let maxVal = 0;
      let maxIndex = 0;

      for (let i = 0; i < bufferLength; i++) {
        if (dataArray[i] > maxVal) {
          maxVal = dataArray[i];
          maxIndex = i;
        }
      }
      
      setSignalStrength(Math.floor((maxVal / 255) * 100));

      // Only process if loud enough AND not sending
      if (maxVal > PROTOCOL.THRESHOLD && !isSending && !isRelaying) {
        const nyquist = ctx.sampleRate / 2;
        const dominantFreq = (maxIndex / bufferLength) * nyquist;
        
        // Debug Log (Only if it looks like a signal)
        if (dominantFreq > 800) console.log("Hearing:", Math.round(dominantFreq), "Hz");

        handleFrequencyInput(dominantFreq, maxVal);
      } else {
        handleFrequencyInput(0, 0);
      }
      
      animationFrameRef.current = requestAnimationFrame(update);
    };
    
    update();
  };

  // -- DECODER STATE MACHINE --
  const handleFrequencyInput = (freq: number, amplitude: number) => {
    const d = decoderRef.current;
    const now = Date.now();
    
    // Get Frequencies
    const mode = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH : PROTOCOL.MODES.AUDIBLE;

    // 1. Timeout Check
    if (d.buffer.length > 0 && d.silenceTimer && (now - d.silenceTimer > PROTOCOL.SILENCE_TIMEOUT)) {
      commitReceivedMessage();
      return;
    }

    // 2. Noise Gate
    if (amplitude < PROTOCOL.THRESHOLD) {
      d.consecutiveFrames = 0;
      return;
    }

    // Helper: Is freq close to target?
    const isFreq = (target: number) => Math.abs(freq - target) < PROTOCOL.RANGE;

    // --- STATE 1: WAITING FOR MARKER ---
    if (d.state === 'IDLE' || d.state === 'WAIT_MARKER') {
      if (isFreq(mode.MARKER)) {
        d.consecutiveFrames++;
        // Require 3 frames (~120ms) to confirm marker
        if (d.consecutiveFrames >= 3) { 
          console.log("START MARKER DETECTED"); // Debug
          d.state = 'READ_CHAR';
          d.consecutiveFrames = 0;
          if (!isReceiving) setIsReceiving(true);
          if (d.buffer.length > 0) d.silenceTimer = now; // Keep alive
        }
      } else {
        d.consecutiveFrames = 0;
      }
    } 
    // --- STATE 2: READING CHARACTER ---
    else if (d.state === 'READ_CHAR') {
      // If we see the marker again, ignore it (it's just the gap or long beep)
      if (isFreq(mode.MARKER)) {
        d.consecutiveFrames = 0;
        return;
      }

      // Calculate Character
      // freq = BASE + (char * STEP)  -->  char = (freq - BASE) / STEP
      const step = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH.STEP_FREQ : PROTOCOL.STEP_FREQ;
      const rawChar = (freq - mode.BASE) / step;
      // const rawChar = (freq - mode.BASE) / PROTOCOL.STEP_FREQ;
      const estimatedChar = Math.round(rawChar);
      
      // Check if valid ASCII (Space to Tilde)
      if (estimatedChar >= 32 && estimatedChar <= 126) {
         // Check if the frequency is actually close to the expected center
         const expectedFreq = mode.BASE + (estimatedChar * step);
         if (Math.abs(freq - expectedFreq) < (step / 2)) { // Tighten tolerance for stealth
             
             d.consecutiveFrames++;
             // Require 3 frames to confirm character
             if (d.consecutiveFrames >= 3) {
               const char = String.fromCharCode(estimatedChar);
               
               if (char !== d.lastDetectedChar) {
                 console.log("CHAR DETECTED:", char); // Debug
                 d.buffer += char;
                 setIncomingBuffer(d.buffer); 
                 d.lastDetectedChar = char;
                 d.state = 'WAIT_MARKER'; 
                 d.consecutiveFrames = 0;
                 d.silenceTimer = now;
               }
             }
         }
      }
    }
  };

  const commitReceivedMessage = () => {
    const d = decoderRef.current;
    
    if (d.buffer.trim().length > 0) {
      const newMessage: Message = {
        id: Date.now(),
        text: d.buffer,
        sender: 'other',
        timestamp: new Date()
      };
      
      setMessages(prev => [...prev, newMessage]);
      addLog('Message received via audio', 'success');
    }
    
    // Reset Decoder
    d.buffer = '';
    d.lastDetectedChar = null;
    d.state = 'IDLE';
    d.silenceTimer = null;
    setIncomingBuffer('');
    setIsReceiving(false);
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(track => track.stop());
    };
  }, []);

  // -- STEALTH MODE STATE --
  // 1. The State (Updates the UI Button)
  const [isStealthMode, setIsStealthMode] = useState<boolean>(false);
  
  // 2. The Ref (Updates the Audio Engine instantly)
  const isStealthModeRef = useRef<boolean>(false);

  // 3. The Toggle Function (Syncs both)
  const toggleStealthMode = () => {
    const newMode = !isStealthMode;
    setIsStealthMode(newMode);          // Update UI
    isStealthModeRef.current = newMode; // Update Audio Engine
    addLog(`Switched to ${newMode ? 'STEALTH' : 'AUDIBLE'} mode`, 'info');
  };

  // 1. LOAD WHISPER MODEL (Runs once on mount)
  // 1. LOAD WHISPER MODEL
  useEffect(() => {
    const loadModel = async () => {
      try {
        addLog("Loading AI engine...", "info");
        
        // --- THE FIX: Load from CDN to bypass Vite bundling errors ---
        // @ts-ignore
        const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
        
        // Configure to allow local models if cached, or fetch from remote
        env.allowLocalModels = false; 
        
        // Load the model
        addLog("Downloading model weights (~40MB)...", "info");
        const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        
        setTranscriber(() => pipe); 
        setIsModelLoading(false);
        addLog("Offline AI Ready! (WiFi can now be turned off)", "success");
        // -------------------------------------------------------------

      } catch (err) {
        console.error(err);
        setIsModelLoading(false);
        addLog("AI Load Failed. Check Internet connection for first run.", "error");
      }
    };
    loadModel();
  }, []);

  // 2. TRANSCRIBE AUDIO (The "Brain")
  const transcribeAudio = async (audioBlob: Blob) => {
    if (!transcriber) return;
    
    addLog("Processing speech locally...", "info");
    
    // Create a URL for the blob so the model can read it
    const url = URL.createObjectURL(audioBlob);
    
    try {
        const result = await transcriber(url);
        // Append result to input text
        setInputText(prev => (prev + " " + result.text).trim());
    } catch (e) {
        console.error(e);
        addLog("Transcription failed", "error");
    }
  };

  // 3. HANDLE RECORDING (The "Ears")
  const toggleAiRecording = async () => {
    // A. If currently recording, STOP it.
    if (isRecordingAI && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        setIsRecordingAI(false);
        return;
    }

    // B. If NOT recording, START it.
    if (!transcriber) {
        addLog("AI Model is still loading...", "error");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = []; // Reset chunks

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunksRef.current.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(chunksRef.current, { type: 'audio/wav' });
            transcribeAudio(audioBlob);
            
            // Stop all tracks to release mic
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        setIsRecordingAI(true);
        addLog("Listening... (Click Mic to stop)", "info");

    } catch (err) {
        console.error(err);
        addLog("Could not access microphone for AI", "error");
    }
  };

  const sendMessage = (): void => {
    if (!inputText.trim() || !micPermission || isSending) return;
    
    const newMessage: Message = {
      id: Date.now(),
      text: inputText,
      sender: 'me',
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, newMessage]);
    const textToSend = inputText;
    setInputText('');
    
    setIsSending(true);
    addLog('Transmitting audio data...', 'info');
    
    transmitAudio(textToSend, () => {
      setIsSending(false);
      addLog('Transmission complete', 'success');
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out forwards;
        }
        /* Visualizer Bars */
        .eq-bar { animation: eq 0.5s infinite ease-in-out alternate; }
        @keyframes eq { 0% { height: 20%; } 100% { height: 100%; } }
      `}</style>

      {/* Onboarding Modal */}
      {showOnboarding && (
        <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 backdrop-blur-sm p-4">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-blue-500">
            <div className="flex justify-center mb-6">
              <div className="relative">
                <WifiOff className="w-16 h-16 text-blue-400" />
                <div className="absolute -top-2 -right-2 w-8 h-8 bg-red-500 rounded-full flex items-center justify-center">
                  <span className="text-white text-xl font-bold">/</span>
                </div>
              </div>
            </div>
            
            <h2 className="text-3xl font-bold text-center mb-4 bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
              NoFi Audio Modem
            </h2>
            
            <p className="text-gray-300 text-center mb-6">
              This version uses <strong>actual sound waves</strong> to transmit data. Ensure your volume is up and microphone is enabled.
            </p>

            {/* Secure Context Warning */}
            {!isSecureContext && (
              <div className="bg-red-900 bg-opacity-50 border border-red-500 rounded-lg p-3 mb-4 text-sm text-red-200 flex items-start gap-2">
                <Lock className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>Security Alert:</strong> This app requires HTTPS to access the microphone.
                  <br />
                  <span className="text-xs opacity-75">If you are running this locally, use localhost. If deployed, ensure SSL is enabled.</span>
                </div>
              </div>
            )}
            
            <div className="bg-yellow-900 bg-opacity-30 border border-yellow-600 rounded-lg p-4 mb-6">
              <p className="text-sm text-yellow-200 flex gap-2">
                <Activity className="w-5 h-5 flex-shrink-0" />
                <span>
                  <strong>Warning:</strong> Produces high-pitched tones. Do not use if sensitive to loud noises.
                </span>
              </p>
            </div>
            
            <button
              onClick={requestMicPermission}
              disabled={!isSecureContext}
              className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-all transform hover:scale-105 flex items-center justify-center gap-2"
            >
              <Mic className="w-5 h-5" />
              {isSecureContext ? 'Initialize Modem' : 'HTTPS Required'}
            </button>
          </div>
        </div>
      )}

      {/* Main Chat Interface */}
      <div className="h-screen w-full bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900 flex flex-col overflow-hidden text-sans">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-cyan-600 p-4 flex items-center justify-between shadow-lg flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            {/* ... (Left side content: Logo, Title, Relay Badge) ... */}
             <div className="flex items-center gap-3">
              <div className="relative">
                <WifiOff className="w-8 h-8 text-white" />
                <Activity className={`absolute -bottom-1 -right-1 w-4 h-4 text-white ${isSending || isReceiving ? 'animate-pulse' : 'hidden'}`} />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  NoFi 
                  <span className="text-xs font-normal bg-black/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                    {isSecureContext ? <Lock className="w-3 h-3 text-green-400" /> : <Lock className="w-3 h-3 text-red-400" />}
                    {isSecureContext ? 'Secure' : 'Not Secure'}
                  </span>
                </h1>
                <p className="text-xs text-blue-100 font-mono">MODEM: {isSending ? 'TX' : isReceiving ? 'RX' : 'IDLE'}</p>
              </div>
            </div>

            {/* Relay Stats Badge */}
            {micPermission && (
              <div className="hidden md:flex items-center gap-2 bg-black/20 px-3 py-1 rounded-full border border-white/10 backdrop-blur-sm">
                <Repeat className={`w-3 h-3 ${isRelaying ? 'text-amber-400 animate-spin' : 'text-gray-400'}`} />
                <div className="text-xs flex gap-1">
                  <span className="text-blue-100">Relayed:</span>
                  <span className="text-amber-400 font-mono font-bold">{relayCount}</span>
                </div>
              </div>
            )}
          </div>
          
          {/* RIGHT SIDE CONTROLS */}
          <div className="flex items-center gap-3">
            
            {/* --- NEW: STEALTH TOGGLE BUTTON --- */}
            <button
              onClick={toggleStealthMode}
              className={`
                hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border transition-all
                ${isStealthMode 
                  ? 'bg-red-900/80 border-red-500 text-red-200 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.5)]' 
                  : 'bg-black/20 border-white/10 text-blue-200 hover:bg-black/40'}
              `}
              title="Switch between Audible (1.2kHz) and Stealth (18.5kHz)"
            >
              {isStealthMode ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  STEALTH
                </>
              ) : (
                <>
                  <Signal className="w-3 h-3" />
                  AUDIBLE
                </>
              )}
            </button>
            {/* ---------------------------------- */}

            {/* Signal Meter (Existing Code) */}
            <div className="text-right hidden sm:block">
              <div className="text-xs text-blue-100">FREQ</div>
              <div className="text-sm font-bold text-white font-mono">{signalStrength > 10 ? 'DETECT' : 'LOW'}</div>
            </div>
            {/* Visualizer (Existing Code) */}
            <div className="w-24 sm:w-32 h-8 bg-black/40 rounded flex items-end justify-between px-1 pb-1 gap-0.5 border border-white/10">
              {[...Array(8)].map((_, i) => (
                <div 
                  key={i}
                  className="w-full bg-cyan-400 rounded-t-sm transition-all duration-75"
                  style={{ 
                    height: `${Math.min(100, Math.max(10, audioLevel * (1 + Math.sin(i + Date.now()/100)) ))}%`,
                    opacity: micPermission ? 1 : 0.3
                  }} 
                />
              ))}
            </div>
            {micPermission ? (
              <Mic className={`w-6 h-6 ${isReceiving ? 'text-green-400 animate-pulse' : 'text-blue-300'}`} />
            ) : (
              <MicOff className="w-6 h-6 text-red-400" />
            )}
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          
          {/* Transmission Visuals */}
          {isSending && (
            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
              <div className="absolute inset-0 bg-blue-500 opacity-5 animate-pulse" />
              <div className="absolute top-0 left-0 w-full h-1 bg-cyan-500 animate-[loading_1s_ease-in-out_infinite]" />
            </div>
          )}

          {isRelaying && (
            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden flex items-center justify-center">
              <div className="bg-amber-500/10 absolute inset-0 animate-pulse" />
              <div className="bg-black/80 text-amber-500 px-6 py-2 rounded-full border border-amber-500/50 backdrop-blur-md font-mono text-sm animate-bounce">
                RE-BROADCASTING AUDIO...
              </div>
            </div>
          )}

          {/* Incoming Buffer Display (Real-time decoding) */}
          {isReceiving && (
             <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/80 border border-green-500 px-6 py-3 rounded-xl z-30 flex flex-col items-center">
                <span className="text-green-500 text-xs font-mono uppercase tracking-widest mb-1">Incoming Transmission</span>
                <span className="text-white font-mono text-lg min-h-[1.5rem]">{incomingBuffer}<span className="animate-pulse">_</span></span>
             </div>
          )}

          {/* Logs */}
          {logs.length > 0 && (
            <div className="absolute top-4 right-4 bg-black bg-opacity-90 backdrop-blur-md p-3 rounded-lg border border-cyan-500 z-10 max-w-xs shadow-xl pointer-events-none">
              <div className="text-xs font-mono space-y-1">
                {logs.map((log, idx) => (
                  <div 
                    key={idx}
                    className={`flex items-start gap-2 ${
                      log.type === 'error' ? 'text-red-400' : 
                      log.type === 'success' ? 'text-green-400' : 
                      'text-cyan-400'
                    }`}
                  >
                    <span className="text-gray-500 flex-shrink-0">[{log.timestamp}]</span>
                    <span className="flex-1">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scrollable Messages */}
          <div 
            className={`flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 pb-24`}
          >
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.sender === 'me' ? 'justify-end' : message.sender === 'system' ? 'justify-center' : 'justify-start'} animate-fadeIn`}
              >
                <div
                  className={`max-w-[85%] sm:max-w-md px-4 py-3 rounded-2xl shadow-lg ${
                    message.sender === 'me'
                      ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white rounded-br-none'
                      : message.sender === 'system'
                      ? 'bg-gray-800/80 border border-gray-700 text-gray-300 text-center text-xs px-6 py-2'
                      : 'bg-gray-700 text-white rounded-bl-none border border-green-500/30'
                  }`}
                >
                  <p className="text-sm break-words leading-relaxed font-sans">{message.text}</p>
                  <p className="text-[10px] opacity-70 mt-1 text-right font-mono">
                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {message.sender === 'other' && ' • RX'}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area */}
        <div className="p-3 sm:p-4 bg-gray-900/95 backdrop-blur border-t border-gray-700 flex-shrink-0 z-20">
          <div className="flex items-center gap-2 sm:gap-3 max-w-4xl mx-auto">
            
            {/* NEW: Offline AI Voice Button */}
            <button
              onClick={toggleAiRecording}
              disabled={isModelLoading || !micPermission}
              className={`p-2 sm:p-3 rounded-xl transition-all transform hover:scale-105 flex-shrink-0 border relative ${
                isRecordingAI 
                  ? 'bg-red-500/20 border-red-500 text-red-400 animate-pulse' 
                  : 'bg-gray-800 border-gray-600 text-gray-400 hover:text-white hover:border-gray-500'
              } ${isModelLoading ? 'opacity-50 cursor-wait' : ''}`}
              title={isModelLoading ? "Loading AI Model..." : "Offline Voice-to-Text"}
            >
              {isModelLoading ? (
                <Loader2 className="w-5 h-5 animate-spin text-cyan-500" />
              ) : isRecordingAI ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
              
              {/* Ready Indicator Dot */}
              {!isModelLoading && !isRecordingAI && transcriber && (
                 <span className="absolute -top-1 -right-1 flex h-2 w-2">
                   <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                   <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                 </span>
              )}
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={
                isModelLoading ? "Loading AI..." :
                isRecordingAI ? "Listening (Offline)..." : 
                micPermission ? "Enter text to transmit..." : "HTTPS Required"
              }
              disabled={!micPermission || isSending}
              className={`flex-1 bg-gray-800 text-white px-3 sm:px-4 py-2 sm:py-3 rounded-xl border border-gray-600 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base transition-all font-mono ${isRecordingAI ? 'border-red-500 ring-1 ring-red-500/50 placeholder-red-400/50' : ''}`}
            />
            <button
              onClick={sendMessage}
              disabled={!inputText.trim() || !micPermission || isSending}
              className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed text-white p-2 sm:p-3 rounded-xl transition-all transform hover:scale-105 active:scale-95 disabled:hover:scale-100 shadow-lg flex-shrink-0"
            >
              <Send className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default NoFiChat;