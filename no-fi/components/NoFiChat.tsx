import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Signal, WifiOff, Repeat, Activity, Lock, Loader2, Inbox, X, Zap, Radio, Waves, MessageCircle } from 'lucide-react';

interface Message {
  id: string;
  text: string;
  sender: 'me' | 'other' | 'system';
  timestamp: Date;
}

interface Log {
  message: string;
  type: 'info' | 'success' | 'error';
  timestamp: string;
}

interface RelayMessage {
  id: string;
  text: string;
  receivedAt: Date;
  status: 'pending' | 'relayed';
  relayAfter: number;
}

// -- AUDIO PROTOCOL CONSTANTS --
const PROTOCOL = {
  // Physics
  FFT_SIZE: 1024,         // Fast scanning (~21ms per frame)
  THRESHOLD: 20,          // Noise gate level
  RANGE: 100,             // +/- 100Hz tolerance
  
  // Timing
  TONE_DURATION: 0.12,    // 120ms per character
  GAP_DURATION: 0.04,     // 40ms silence between tones
  SILENCE_TIMEOUT: 1000,  // 1s silence = Message Done
  IDLE_TIMEOUT: 3000,     // Reset decoder if stuck
  SEPARATOR: '|',         // ID separator
  
  // Frequencies
  STEP_FREQ: 60,          // Default step for Audible
  
  // Modes
  MODES: {
    AUDIBLE: { 
        MARKER: 2000, 
        BASE: 2200 
    }, 
    STEALTH: { 
        MARKER: 16000, 
        BASE: 16500,
        STEP_FREQ: 40     // Tighter step for Stealth to fit bandwidth
    }
  }
};

const NoFiChat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: "SYS1", text: "🎯 NoFi Audio Modem Ready • Mesh Network Active", sender: "system", timestamp: new Date() }
  ]);
  const [inputText, setInputText] = useState<string>('');
  const [logs, setLogs] = useState<Log[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(true);
  const [micPermission, setMicPermission] = useState<boolean>(false);
  const [isSecureContext, setIsSecureContext] = useState<boolean>(true);
  
  const [relayQueue, setRelayQueue] = useState<RelayMessage[]>([]);
  const [showRelayQueue, setShowRelayQueue] = useState<boolean>(false);
  
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isReceiving, setIsReceiving] = useState<boolean>(false);
  const [incomingBuffer, setIncomingBuffer] = useState<string>('');
  
  const [signalStrength, setSignalStrength] = useState<number>(0);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  
  // Stealth Mode State
  const [isStealthMode, setIsStealthMode] = useState<boolean>(false);
  const isStealthModeRef = useRef<boolean>(false);

  // Offline AI State
  const [transcriber, setTranscriber] = useState<any>(null);
  const [isModelLoading, setIsModelLoading] = useState<boolean>(true);
  const [isRecordingAI, setIsRecordingAI] = useState<boolean>(false);
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isSendingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<string>>(new Set(["SYS1"]));
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // Decoder State
  const decoderRef = useRef({
    state: 'IDLE' as 'IDLE' | 'WAIT_MARKER' | 'READ_CHAR',
    buffer: '',
    lastDetectedChar: null as string | null,
    silenceTimer: null as number | null,
    lastValidRead: Date.now(),
    lastCharDecoded: Date.now(),
    consecutiveFrames: 0,
    activeMode: 'AUDIBLE' as 'AUDIBLE' | 'STEALTH' 
  });

  const generateId = () => Math.random().toString(36).substring(2, 6).toUpperCase();

  // -- INITIALIZATION & CHECKS --
  useEffect(() => {
    // 1. Inject Tailwind
    if (!document.querySelector('script[src*="tailwindcss"]')) {
      const script = document.createElement('script');
      script.src = "https://cdn.tailwindcss.com";
      script.async = true;
      document.head.appendChild(script);
    }

    // 2. Enforce HTTPS
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
      window.location.href = window.location.href.replace(/^http:/, 'https:');
    }
    if (!window.isSecureContext) {
      setIsSecureContext(false);
      addLog('Error: App must run via HTTPS', 'error');
    }

    // 3. Load Offline AI (from CDN)
    const loadModel = async () => {
      try {
        addLog("Loading AI engine...", "info");
        // @ts-ignore
        const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
        env.allowLocalModels = false; 
        
        addLog("Downloading model weights (~40MB)...", "info");
        const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        
        setTranscriber(() => pipe); 
        setIsModelLoading(false);
        addLog("Offline AI Ready! (WiFi can now be turned off)", "success");
      } catch (err) {
        console.error(err);
        setIsModelLoading(false);
        addLog("AI Load Failed. Check Internet for first run.", "error");
      }
    };
    loadModel();

    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(track => track.stop());
    };
  }, []);

  // -- RELAY QUEUE PROCESSOR --
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      
      setRelayQueue(prev => {
        // Don't interrupt if busy
        if (isSendingRef.current || isReceiving) return prev;
        
        const toRelay = prev.filter(msg => 
          msg.status === 'pending' && 
          (now - msg.receivedAt.getTime()) >= msg.relayAfter
        );
        
        if (toRelay.length > 0) {
          const msg = toRelay[0];
          
          // Start Relay
          setIsSending(true);
          isSendingRef.current = true;
          
          const payload = `${msg.id}${PROTOCOL.SEPARATOR}${msg.text}`;
          addLog(`Auto-relaying: #${msg.id}`, 'info');
          
          transmitAudio(payload, () => {
            setIsSending(false);
            setTimeout(() => { isSendingRef.current = false; }, 500);
            
            setRelayQueue(queue => queue.map(m => 
              m.id === msg.id ? { ...m, status: 'relayed' as const } : m
            ));
            
            addLog(`Auto-relayed: #${msg.id}`, 'success');
          });
        }
        return prev;
      });
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isReceiving]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, incomingBuffer]);

  // -- HELPERS --
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const addLog = (message: string, type: 'info' | 'success' | 'error' = 'info'): void => {
    const logEntry: Log = { message, type, timestamp: new Date().toLocaleTimeString() };
    setLogs(prev => [...prev.slice(-4), logEntry]);
  };

  const toggleStealthMode = () => {
    const newMode = !isStealthMode;
    setIsStealthMode(newMode);
    isStealthModeRef.current = newMode;
    addLog(`Switched to ${newMode ? 'STEALTH' : 'AUDIBLE'} mode`, 'info');
  };

  // -- AUDIO ENGINE INITIALIZATION --
  const requestMicPermission = async (): Promise<void> => {
    if (!isSecureContext) {
      addLog('HTTPS required for Microphone', 'error');
      return;
    }

    try {
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
      
      // Infinite Silence Hack to keep AudioContext alive for Relay
      const osc = audioContextRef.current.createOscillator();
      const gain = audioContextRef.current.createGain();
      osc.connect(gain);
      gain.connect(audioContextRef.current.destination);
      osc.frequency.value = 440;
      gain.gain.value = 0.0001; 
      osc.start();

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

  // -- AI VOICE FUNCTIONS --
  const transcribeAudio = async (audioBlob: Blob) => {
    if (!transcriber) return;
    addLog("Processing speech locally...", "info");
    const url = URL.createObjectURL(audioBlob);
    try {
        const result = await transcriber(url);
        setInputText(prev => (prev + " " + result.text).trim());
    } catch (e) {
        console.error(e);
        addLog("Transcription failed", "error");
    }
  };

  const toggleAiRecording = async () => {
    if (isRecordingAI && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        setIsRecordingAI(false);
        return;
    }
    if (!transcriber) {
        addLog("AI Model is still loading...", "error");
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(chunksRef.current, { type: 'audio/wav' });
            transcribeAudio(audioBlob);
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

  // -- TRANSMITTER (FSK ENCODER) --
  const transmitAudio = (text: string, onComplete?: () => void) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // 1. Select Config based on Mode
    const mode = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH : PROTOCOL.MODES.AUDIBLE;

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0, now);
    let startTime = now + 0.1;

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      // Get correct step size
      const currentStep = isStealthModeRef.current ? PROTOCOL.MODES.STEALTH.STEP_FREQ : PROTOCOL.STEP_FREQ;
      const freq = mode.BASE + (charCode * currentStep);

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
    
    // CRITICAL: Set FFT Size
    analyserRef.current.fftSize = PROTOCOL.FFT_SIZE;
    
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = audioContextRef.current;
    
    const update = (): void => {
      if (!analyserRef.current) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      
      let sum = 0;
      let maxVal = 0;
      let maxIndex = 0;

      for (let i = 0; i < bufferLength; i++) {
        if (dataArray[i] > maxVal) {
          maxVal = dataArray[i];
          maxIndex = i;
        }
        sum += dataArray[i];
      }
      
      const average = sum / bufferLength;
      setAudioLevel(Math.min(100, (average / 50) * 100));
      setSignalStrength(Math.floor(Math.min(100, (maxVal / 255) * 100)));

      // Only process audio if not currently sending
      if (!isSendingRef.current) {
        if (maxVal > PROTOCOL.THRESHOLD) {
          const nyquist = ctx.sampleRate / 2;
          const dominantFreq = (maxIndex / bufferLength) * nyquist;
          handleFrequencyInput(dominantFreq, maxVal);
        } else {
          handleFrequencyInput(0, 0);
        }
      } else {
        decoderRef.current.consecutiveFrames = 0;
      }
      
      animationFrameRef.current = requestAnimationFrame(update);
    };
    
    update();
  };

  // -- DECODER STATE MACHINE (SMART DUAL-MODE) --
  const handleFrequencyInput = (freq: number, amplitude: number) => {
    const d = decoderRef.current;
    const now = Date.now();

    // 1. Timeout Checks
    if (d.buffer.length > 0 && (now - d.lastCharDecoded > 3000)) {
      addLog('Timeout: Committing partial message', 'info');
      commitReceivedMessage();
      return;
    }
    if (d.buffer.length > 0 && d.silenceTimer !== null && (now - d.silenceTimer > PROTOCOL.SILENCE_TIMEOUT)) {
      commitReceivedMessage();
      return;
    }
    if (d.state !== 'IDLE' && d.buffer.length === 0 && (now - d.lastValidRead > PROTOCOL.IDLE_TIMEOUT)) {
      d.state = 'IDLE';
      d.buffer = '';
      d.lastDetectedChar = null;
      d.consecutiveFrames = 0;
      setIncomingBuffer('');
      setIsReceiving(false);
      return;
    }

    // 2. Noise Gate
    if (amplitude < PROTOCOL.THRESHOLD) {
      d.consecutiveFrames = 0;
      if (d.buffer.length > 0 && d.silenceTimer === null) d.silenceTimer = now;
      return;
    }
    if (d.buffer.length > 0) d.silenceTimer = null;

    // Helper: Check frequency
    const isFreq = (target: number, range = 100) => Math.abs(freq - target) < range;

    // --- STATE 1: SCAN FOR MARKER (AUTO-DETECT MODE) ---
    if (d.state === 'IDLE' || d.state === 'WAIT_MARKER') {
      let detectedMode = null;

      if (isFreq(PROTOCOL.MODES.AUDIBLE.MARKER)) detectedMode = 'AUDIBLE';
      else if (isFreq(PROTOCOL.MODES.STEALTH.MARKER)) detectedMode = 'STEALTH';

      if (detectedMode) {
        d.activeMode = detectedMode as 'AUDIBLE' | 'STEALTH'; // Lock onto detected mode
        d.consecutiveFrames++;
        if (d.consecutiveFrames >= 2) { 
          d.state = 'READ_CHAR';
          d.consecutiveFrames = 0;
          d.lastDetectedChar = null;
          d.lastValidRead = now;
          if (!isReceiving) setIsReceiving(true);
          if (d.buffer.length > 0) d.silenceTimer = now; 
        }
      } else {
        d.consecutiveFrames = 0;
      }
    } 
    // --- STATE 2: READ CHARACTER ---
    else if (d.state === 'READ_CHAR') {
      const currentConfig = PROTOCOL.MODES[d.activeMode];
      const currentStep = d.activeMode === 'STEALTH' ? PROTOCOL.MODES.STEALTH.STEP_FREQ : PROTOCOL.STEP_FREQ;

      if (isFreq(currentConfig.MARKER)) {
        d.consecutiveFrames = 0;
        return;
      }

      const rawChar = (freq - currentConfig.BASE) / currentStep;
      const estimatedChar = Math.round(rawChar);
      
      if (estimatedChar >= 32 && estimatedChar <= 126) {
         const expectedFreq = currentConfig.BASE + (estimatedChar * currentStep);
         if (Math.abs(freq - expectedFreq) < (currentStep / 2)) {
             d.consecutiveFrames++;
             if (d.consecutiveFrames >= 3) {
               const char = String.fromCharCode(estimatedChar);
               if (char !== d.lastDetectedChar) {
                 d.buffer += char;
                 setIncomingBuffer(d.buffer); 
                 d.lastDetectedChar = char;
                 d.lastCharDecoded = now;
                 d.state = 'WAIT_MARKER'; 
                 d.consecutiveFrames = 0;
                 d.lastValidRead = now;
                 d.silenceTimer = now;
               }
             }
         } else {
            d.consecutiveFrames = 0;
         }
      } else {
         d.consecutiveFrames = 0;
      }
    }
  };

  const commitReceivedMessage = () => {
    const d = decoderRef.current;
    const rawData = d.buffer.trim();
    
    if (rawData.length > 0) {
      let msgId = generateId();
      let msgText = rawData;

      // Parse ID if present
      if (rawData.includes(PROTOCOL.SEPARATOR)) {
        const parts = rawData.split(PROTOCOL.SEPARATOR);
        if (parts.length >= 2) {
          msgId = parts[0];
          msgText = parts.slice(1).join(PROTOCOL.SEPARATOR);
        }
      }

      if (seenIdsRef.current.has(msgId)) {
        addLog(`Ignored duplicate #${msgId}`, 'info');
      } else {
        seenIdsRef.current.add(msgId);
        
        const newMessage: Message = {
          id: msgId,
          text: msgText,
          sender: 'other',
          timestamp: new Date()
        };
        
        setMessages(prev => [...prev, newMessage]);
        
        // Queue for Relay
        const randomDelay = 10000 + Math.random() * 10000;
        const relayMessage: RelayMessage = {
          id: msgId,
          text: msgText,
          receivedAt: new Date(),
          status: 'pending',
          relayAfter: randomDelay
        };
        setRelayQueue(prev => [...prev, relayMessage]);
        
        addLog(`RX: #${msgId} (relay in ${Math.round(randomDelay/1000)}s)`, 'success');
      }
    }
    
    // Reset
    d.buffer = '';
    d.lastDetectedChar = null;
    d.state = 'IDLE';
    d.silenceTimer = null;
    d.lastCharDecoded = Date.now();
    setIncomingBuffer('');
    setIsReceiving(false);
  };

  const sendMessage = (textOverride?: string): void => {
    const textToSend = textOverride || inputText;
    if (!textToSend.trim() || !micPermission || isSending) return;
    
    const newId = generateId();
    seenIdsRef.current.add(newId);

    const newMessage: Message = {
      id: newId,
      text: textToSend,
      sender: 'me',
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, newMessage]);
    const payload = `${newId}${PROTOCOL.SEPARATOR}${textToSend}`;
    setInputText('');
    
    setIsSending(true);
    isSendingRef.current = true;
    
    addLog(`TX: #${newId}`, 'info');
    
    transmitAudio(payload, () => {
      setIsSending(false);
      setTimeout(() => { isSendingRef.current = false; }, 500);
      addLog('Transmission complete', 'success');
    });
  };

  const relayMessage = (msgId: string): void => {
    const message = relayQueue.find(m => m.id === msgId);
    if (!message || message.status === 'relayed') return;
    
    setIsSending(true);
    isSendingRef.current = true;
    
    const payload = `${message.id}${PROTOCOL.SEPARATOR}${message.text}`;
    addLog(`Relaying: #${msgId}`, 'info');
    
    transmitAudio(payload, () => {
      setIsSending(false);
      setTimeout(() => { isSendingRef.current = false; }, 500);
      
      setRelayQueue(prev => prev.map(m => 
        m.id === msgId ? { ...m, status: 'relayed' as const } : m
      ));
      
      addLog(`Relayed: #${msgId}`, 'success');
    });
  };

  const clearRelayQueue = (): void => {
    setRelayQueue([]);
    addLog('Relay queue cleared', 'info');
  };

  return (
    <>
      {/* ... (Styles Block - Same as before) ... */}
      <style>{`
        /* ... (Paste your existing styles here) ... */
        * { -webkit-tap-highlight-color: transparent; }
        .animate-fadeIn { animation: fadeIn 0.4s ease-out forwards; }
        .glass-ultra { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); }
        .glass-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); }
        .mesh-gradient { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); }
      `}</style>

      {/* Onboarding Modal */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="glass-ultra p-8 rounded-3xl max-w-md text-center border border-cyan-500/30">
            <WifiOff className="w-16 h-16 text-cyan-400 mx-auto mb-4" />
            <h2 className="text-3xl font-bold text-white mb-2">NoFi Modem</h2>
            <p className="text-cyan-100/80 mb-6">Offline Mesh Network via Audio</p>
            {!isSecureContext && <p className="text-red-400 text-sm mb-4">HTTPS Required</p>}
            <button onClick={requestMicPermission} disabled={!isSecureContext} className="w-full bg-cyan-600 hover:bg-cyan-500 text-white py-3 rounded-xl font-bold">
              {isSecureContext ? 'Activate Modem' : 'Secure Context Needed'}
            </button>
          </div>
        </div>
      )}

      {/* Relay Queue Panel */}
      {showRelayQueue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="glass-ultra w-full max-w-lg p-6 rounded-3xl border border-green-500/30 max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-green-400 flex gap-2"><Inbox/> Relay Queue</h3>
              <button onClick={() => setShowRelayQueue(false)}><X className="text-gray-400"/></button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3">
              {relayQueue.map(msg => (
                <div key={msg.id} className="glass-card p-4 rounded-xl flex justify-between items-center">
                  <div>
                    <p className="text-white text-sm font-mono">#{msg.id}</p>
                    <p className="text-gray-400 text-xs truncate w-40">{msg.text}</p>
                  </div>
                  {msg.status === 'pending' ? (
                    <button onClick={() => relayMessage(msg.id)} className="bg-green-600 px-3 py-1 rounded text-xs font-bold">Relay</button>
                  ) : <span className="text-gray-500 text-xs">Sent</span>}
                </div>
              ))}
              {relayQueue.length === 0 && <p className="text-center text-gray-500 py-8">Queue empty</p>}
            </div>
          </div>
        </div>
      )}

      {/* Main App */}
      <div className="h-screen w-full mesh-gradient flex flex-col">
        {/* Header */}
        <div className="glass-ultra p-4 flex justify-between items-center z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-500/20 rounded-lg"><Radio className="text-cyan-400"/></div>
            <div>
              <h1 className="font-bold text-white leading-none">NoFi</h1>
              <p className="text-[10px] text-cyan-300 font-mono">
                {isSending ? 'TX: SENDING' : isReceiving ? 'RX: DECODING' : 'IDLE'}
              </p>
            </div>
          </div>
          
          <div className="flex gap-2">
            <button onClick={() => setShowRelayQueue(true)} className="p-2 glass-card rounded-lg relative">
              <Inbox className="w-5 h-5 text-gray-300"/>
              {relayQueue.some(m => m.status === 'pending') && <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full"/>}
            </button>
            
            <button 
              onClick={toggleStealthMode}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${isStealthMode ? 'border-red-500 bg-red-500/20 text-red-300' : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'}`}
            >
              {isStealthMode ? <><Activity className="w-4 h-4"/> Stealth</> : <><Signal className="w-4 h-4"/> Audible</>}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isReceiving && (
            <div className="flex justify-center">
              <div className="bg-green-900/50 border border-green-500/50 px-6 py-2 rounded-full text-green-300 font-mono animate-pulse">
                Rx: {incomingBuffer}<span className="animate-blink">_</span>
              </div>
            </div>
          )}
          
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.sender === 'me' ? 'justify-end' : msg.sender === 'system' ? 'justify-center' : 'justify-start'}`}>
              <div className={`max-w-[80%] p-4 rounded-2xl ${
                msg.sender === 'me' ? 'bg-cyan-600 text-white rounded-br-none' : 
                msg.sender === 'system' ? 'bg-gray-800/50 text-gray-400 text-xs py-1 px-4' :
                'bg-gray-800 text-white border border-gray-700 rounded-bl-none'
              }`}>
                {msg.text}
                {msg.sender !== 'system' && <div className="text-[9px] opacity-50 mt-1 text-right font-mono">#{msg.id}</div>}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef}/>
        </div>

        {/* Input */}
        <div className="p-4 glass-ultra pb-8">
          {/* Chips */}
          <div className="flex gap-2 mb-3 overflow-x-auto pb-2">
            {[
              {label: 'SOS', text: 'SOS! Need Help!', color: 'bg-red-600'},
              {label: 'SAFE', text: 'I am safe.', color: 'bg-green-600'},
              {label: 'WATER', text: 'Need water.', color: 'bg-blue-600'}
            ].map(chip => (
              <button key={chip.label} onClick={() => sendMessage(chip.text)} className={`${chip.color} px-4 py-1 rounded-full text-xs font-bold shadow-lg hover:brightness-110 transition-all whitespace-nowrap`}>
                {chip.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button 
              onClick={toggleAiRecording}
              disabled={isModelLoading}
              className={`p-3 rounded-xl border ${isRecordingAI ? 'border-red-500 bg-red-500/20 animate-pulse' : 'border-gray-600 bg-gray-800'}`}
            >
              {isModelLoading ? <Loader2 className="w-5 h-5 animate-spin"/> : <Mic className="w-5 h-5"/>}
            </button>
            
            <input 
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
              placeholder={isRecordingAI ? "Listening..." : "Enter message..."}
              className="flex-1 bg-gray-800 rounded-xl px-4 border border-gray-600 focus:border-cyan-500 outline-none font-mono"
            />
            
            <button onClick={() => sendMessage()} className="p-3 bg-cyan-600 rounded-xl hover:bg-cyan-500">
              <Send className="w-5 h-5"/>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default NoFiChat;