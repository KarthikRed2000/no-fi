import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Signal, WifiOff, Repeat, Activity, Lock, Loader2, Inbox } from 'lucide-react';
// import { pipeline } from '@xenova/transformers';

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
  relayAfter: number; // Random delay in milliseconds (10-20 seconds)
}

// -- AUDIO PROTOCOL CONSTANTS --
const PROTOCOL = {
  MARKER_FREQ: 1200,      
  BASE_FREQ: 1500,        
  STEP_FREQ: 40,          
  TONE_DURATION: 0.08,    
  GAP_DURATION: 0.02,     
  FFT_SIZE: 2048,
  THRESHOLD: 30,          
  SILENCE_TIMEOUT: 1500,
  IDLE_TIMEOUT: 3000,
  SEPARATOR: '|'
};

const NoFiChat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: "SYS1", text: "NoFi Chat initialized. Received messages will display on left and be stored in relay queue.", sender: "system", timestamp: new Date() }
  ]);
  const [inputText, setInputText] = useState<string>('');
  const [logs, setLogs] = useState<Log[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(true);
  const [micPermission, setMicPermission] = useState<boolean>(false);
  const [isSecureContext, setIsSecureContext] = useState<boolean>(true);
  
  // Relay Queue
  const [relayQueue, setRelayQueue] = useState<RelayMessage[]>([]);
  const [showRelayQueue, setShowRelayQueue] = useState<boolean>(false);
  
  // Transmission States
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isReceiving, setIsReceiving] = useState<boolean>(false);
  const [incomingBuffer, setIncomingBuffer] = useState<string>('');
  
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
  const isSendingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<string>>(new Set(["SYS1"]));

  // Decoder State
  const decoderRef = useRef({
    state: 'IDLE' as 'IDLE' | 'WAIT_MARKER' | 'READ_CHAR',
    buffer: '',
    lastDetectedChar: null as string | null,
    silenceTimer: null as number | null,
    lastValidRead: Date.now(),
    lastCharDecoded: Date.now(),
    consecutiveFrames: 0,
    lastFreqIndex: 0
  });

  // -- HELPER: Generate Short ID --
  const generateId = () => Math.random().toString(36).substring(2, 6).toUpperCase();

  // -- AUTO-RELAY EFFECT --
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      
      setRelayQueue(prev => {
        // Don't auto-relay while receiving or sending - just wait
        if (isSendingRef.current || isReceiving) {
          return prev; // Wait, don't skip - timer keeps running
        }
        
        // Find messages that are pending and past their random relay time
        const toRelay = prev.filter(msg => 
          msg.status === 'pending' && 
          (now - msg.receivedAt.getTime()) >= msg.relayAfter
        );
        
        // Auto-relay the first pending message that's ready
        if (toRelay.length > 0) {
          const msg = toRelay[0];
          
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
    }, 1000); // Check every second
    
    return () => clearInterval(interval);
  }, [isReceiving]); // Add isReceiving as dependency

  // -- SYSTEM CHECKS --
  useEffect(() => {
    if (!document.querySelector('script[src*="tailwindcss"]')) {
      const script = document.createElement('script');
      script.src = "https://cdn.tailwindcss.com";
      script.async = true;
      document.head.appendChild(script);
    }

    if (
      window.location.protocol === 'http:' && 
      window.location.hostname !== 'localhost' && 
      window.location.hostname !== '127.0.0.1'
    ) {
      window.location.href = window.location.href.replace(/^http:/, 'https:');
    }
    
    if (!window.isSecureContext) {
      setIsSecureContext(false);
      addLog('Error: App must run via HTTPS', 'error');
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, incomingBuffer]);

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
  const transmitAudio = (payload: string, onComplete?: () => void) => {
    if (!audioContextRef.current) return;
    
    const ctx = audioContextRef.current;
    
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0, now);
    let startTime = now + 0.1;

    for (let i = 0; i < payload.length; i++) {
      const charCode = payload.charCodeAt(i);
      const freq = PROTOCOL.BASE_FREQ + (charCode * PROTOCOL.STEP_FREQ);

      // 1. Marker
      osc.frequency.setValueAtTime(PROTOCOL.MARKER_FREQ, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.005); 
      startTime += PROTOCOL.TONE_DURATION + PROTOCOL.GAP_DURATION;

      // 2. Data Tone
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.005);
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
        const val = dataArray[i];
        sum += val;
        if (val > maxVal) {
          maxVal = val;
          maxIndex = i;
        }
      }
      
      const average = sum / bufferLength;
      setAudioLevel(Math.min(100, (average / 50) * 100));
      setSignalStrength(Math.floor(Math.min(100, (maxVal / 255) * 100)));

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

  // -- DECODER STATE MACHINE --
  const handleFrequencyInput = (freq: number, amplitude: number) => {
    const d = decoderRef.current;
    const now = Date.now();

    // NO PROGRESS TIMEOUT - If we have data but haven't decoded a new char in 3 seconds, commit and reset
    if (d.buffer.length > 0 && (now - d.lastCharDecoded > 3000)) {
      addLog('No new char for 3s - committing', 'info');
      commitReceivedMessage();
      return;
    }

    // SILENCE TIMEOUT - Check after no-progress timeout
    if (d.buffer.length > 0 && d.silenceTimer !== null && (now - d.silenceTimer > PROTOCOL.SILENCE_TIMEOUT)) {
      commitReceivedMessage();
      return;
    }

    // IDLE TIMEOUT - only reset if no data received
    if (d.state !== 'IDLE' && d.buffer.length === 0 && (now - d.lastValidRead > PROTOCOL.IDLE_TIMEOUT)) {
      d.state = 'IDLE';
      d.buffer = '';
      d.lastDetectedChar = null;
      d.consecutiveFrames = 0;
      setIncomingBuffer('');
      setIsReceiving(false);
      addLog('Signal lost (timeout)', 'info');
      return;
    }

    // Handle silence - start timer when signal drops
    if (amplitude < PROTOCOL.THRESHOLD) {
      d.consecutiveFrames = 0;
      // Start silence timer only once when we first detect silence with data
      if (d.buffer.length > 0 && d.silenceTimer === null) {
        d.silenceTimer = now;
      }
      return;
    }

    // We have a signal - reset silence timer (still receiving)
    if (d.buffer.length > 0 && d.silenceTimer !== null) {
      d.silenceTimer = null;
    }

    const isFreq = (target: number, range = 50) => Math.abs(freq - target) < range;

    if (d.state === 'IDLE' || d.state === 'WAIT_MARKER') {
      if (isFreq(PROTOCOL.MARKER_FREQ)) {
        d.consecutiveFrames++;
        if (d.consecutiveFrames > 2) { 
          d.state = 'READ_CHAR';
          d.consecutiveFrames = 0;
          d.lastDetectedChar = null; // Reset to detect next char
          d.lastValidRead = now;
          if (!isReceiving) setIsReceiving(true);
        }
      } else {
        // Reset consecutive frames if we don't detect marker
        d.consecutiveFrames = 0;
      }
    } 
    else if (d.state === 'READ_CHAR') {
      if (!isFreq(PROTOCOL.MARKER_FREQ)) {
        const estimatedChar = Math.round((freq - PROTOCOL.BASE_FREQ) / PROTOCOL.STEP_FREQ);
        
        if (estimatedChar >= 32 && estimatedChar <= 126) {
           d.consecutiveFrames++;
           
           if (d.consecutiveFrames > 3) {
             const char = String.fromCharCode(estimatedChar);
             
             if (char !== d.lastDetectedChar) {
               d.buffer += char;
               setIncomingBuffer(d.buffer);
               d.lastDetectedChar = char;
               d.lastCharDecoded = now; // Update timestamp when char is decoded
               d.state = 'WAIT_MARKER'; 
               d.consecutiveFrames = 0;
               d.lastValidRead = now;
             }
           }
        } else {
          // Invalid character - reset and wait for marker
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
        
        // Add to messages (persist in chat)
        setMessages(prev => [...prev, newMessage]);
        
        // Add to relay queue with random delay between 10-20 seconds
        const randomDelay = 10000 + Math.random() * 10000; // 10000ms to 20000ms
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
    
    d.buffer = '';
    d.lastDetectedChar = null;
    d.state = 'IDLE';
    d.silenceTimer = null;
    d.lastCharDecoded = Date.now(); // Reset the no-progress timer
    setIncomingBuffer('');
    setIsReceiving(false);
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(track => track.stop());
    };
  }, []);

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
    
    const newId = generateId();
    seenIdsRef.current.add(newId);

    const newMessage: Message = {
      id: newId,
      text: inputText,
      sender: 'me',
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, newMessage]);
    const payload = `${newId}${PROTOCOL.SEPARATOR}${inputText}`;
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
              Audio-based messaging with <strong>relay queue</strong> and <strong>persistent messages</strong>.
            </p>

            {!isSecureContext && (
              <div className="bg-red-900 bg-opacity-50 border border-red-500 rounded-lg p-3 mb-4 text-sm text-red-200 flex items-start gap-2">
                <Lock className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>Security Alert:</strong> HTTPS Required.
                </div>
              </div>
            )}
            
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

      {/* Relay Queue Panel */}
      {showRelayQueue && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 backdrop-blur-sm p-4">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-6 rounded-2xl shadow-2xl w-full max-w-2xl border border-green-500 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-green-400 flex items-center gap-2">
                <Inbox className="w-6 h-6" />
                Relay Queue
              </h2>
              <button
                onClick={() => setShowRelayQueue(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-2 mb-4">
              {relayQueue.length === 0 ? (
                <div className="text-center text-gray-400 py-8">
                  No messages in relay queue
                </div>
              ) : (
                relayQueue.map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-4 rounded-lg border ${
                      msg.status === 'relayed' 
                        ? 'bg-gray-700/50 border-gray-600' 
                        : 'bg-green-900/30 border-green-500/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <p className="text-white mb-2">{msg.text}</p>
                        <div className="flex items-center gap-3 text-xs text-gray-400">
                          <span className="font-mono">ID: {msg.id}</span>
                          <span>{msg.receivedAt.toLocaleTimeString()}</span>
                          <span className={`px-2 py-0.5 rounded ${
                            msg.status === 'relayed' 
                              ? 'bg-gray-600 text-gray-300' 
                              : 'bg-green-600 text-green-100'
                          }`}>
                            {msg.status}
                          </span>
                        </div>
                      </div>
                      {msg.status === 'pending' && (
                        <button
                          onClick={() => relayMessage(msg.id)}
                          disabled={isSending}
                          className="bg-green-500 hover:bg-green-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm transition-all"
                        >
                          Relay
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {relayQueue.length > 0 && (
              <button
                onClick={clearRelayQueue}
                className="w-full bg-red-500/20 hover:bg-red-500/30 border border-red-500 text-red-400 py-2 rounded-lg transition-all"
              >
                Clear Queue
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Chat Interface */}
      <div className="h-screen w-full bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900 flex flex-col overflow-hidden text-sans">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-cyan-600 p-4 flex items-center justify-between shadow-lg flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
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
                <p className="text-xs text-blue-100 font-mono">{isSending ? 'TX: SENDING' : isReceiving ? 'RX: DECODING' : 'STATUS: IDLE'}</p>
              </div>
            </div>

            {micPermission && (
              <div className="hidden md:flex items-center gap-2 bg-black/20 px-3 py-1 rounded-full border border-white/10 backdrop-blur-sm">
                <div className="text-xs flex gap-1">
                  <span className="text-blue-100">Status:</span>
                  <span className="text-green-400 font-mono font-bold">Active</span>
                </div>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {/* Relay Queue Button */}
            <button
              onClick={() => setShowRelayQueue(true)}
              className="relative bg-black/30 hover:bg-black/40 p-2 rounded-lg transition-all border border-white/20"
            >
              <Inbox className="w-5 h-5 text-white" />
              {relayQueue.filter(m => m.status === 'pending').length > 0 && (
                <span className="absolute -top-1 -right-1 bg-green-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                  {relayQueue.filter(m => m.status === 'pending').length}
                </span>
              )}
            </button>
            
            <div className="text-right hidden sm:block">
              <div className="text-xs text-blue-100">FREQ</div>
              <div className="text-sm font-bold text-white font-mono">{signalStrength > 10 ? 'DETECT' : 'LOW'}</div>
            </div>
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
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          
          {isSending && (
            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
              <div className="absolute inset-0 bg-blue-500 opacity-5 animate-pulse" />
              <div className="absolute top-0 left-0 w-full h-1 bg-cyan-500 animate-[loading_1s_ease-in-out_infinite]" />
            </div>
          )}

          {isReceiving && (
             <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/80 border border-green-500 px-6 py-3 rounded-xl z-30 flex flex-col items-center">
                <span className="text-green-500 text-xs font-mono uppercase tracking-widest mb-1">Decoding Audio Stream</span>
                <span className="text-white font-mono text-lg min-h-[1.5rem]">{incomingBuffer}<span className="animate-pulse">_</span></span>
             </div>
          )}

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

          <div className={`flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 pb-24`}>
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
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10 gap-4">
                     <span className="text-[10px] font-mono opacity-50 tracking-wider">
                        ID: {message.id}
                     </span>
                     <span className="text-[10px] opacity-70 font-mono">
                        {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {message.sender === 'other' && ' • RX'}
                     </span>
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

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