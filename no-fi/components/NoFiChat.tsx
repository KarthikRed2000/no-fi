import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Signal, WifiOff, Repeat, Activity, Lock } from 'lucide-react';

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
const PROTOCOL = {
  MARKER_FREQ: 1200,      // Signal start/separator tone (Hz)
  BASE_FREQ: 1500,        // Starting frequency for data (Hz)
  STEP_FREQ: 40,          // Hz per ASCII code
  TONE_DURATION: 0.08,    // Duration of each tone (seconds)
  GAP_DURATION: 0.02,     // Silence between tones
  FFT_SIZE: 2048,
  THRESHOLD: 30,          // Min decibel level to detect
  SILENCE_TIMEOUT: 1500,  // Time to wait before considering message complete (ms)
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

    osc.connect(gain);
    gain.connect(ctx.destination);

    // Initial padding
    gain.gain.setValueAtTime(0, now);
    
    let startTime = now + 0.1;

    // Encode text
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const freq = PROTOCOL.BASE_FREQ + (charCode * PROTOCOL.STEP_FREQ);

      // 1. Play Marker
      osc.frequency.setValueAtTime(PROTOCOL.MARKER_FREQ, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.005); 

      startTime += PROTOCOL.TONE_DURATION + PROTOCOL.GAP_DURATION;

      // 2. Play Data Tone
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
      
      // 1. Visualization Levels
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
      setAudioLevel(Math.min(100, (average / 50) * 100)); // Visual only
      setSignalStrength(Math.floor(Math.min(100, (maxVal / 255) * 100)));

      // 2. Decoding Logic
      if (maxVal > PROTOCOL.THRESHOLD) {
        const nyquist = ctx.sampleRate / 2;
        const dominantFreq = (maxIndex / bufferLength) * nyquist;
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

    // Check for silence timeout to commit message
    if (d.buffer.length > 0 && d.silenceTimer && (now - d.silenceTimer > PROTOCOL.SILENCE_TIMEOUT)) {
      commitReceivedMessage();
      return;
    }

    if (amplitude < PROTOCOL.THRESHOLD) {
      d.consecutiveFrames = 0;
      return;
    }

    // Reset silence timer on any strong signal
    if (d.buffer.length > 0) {
      d.silenceTimer = now;
    }

    // Frequency Matching Helper
    const isFreq = (target: number, range = 50) => Math.abs(freq - target) < range;

    // State Machine
    if (d.state === 'IDLE' || d.state === 'WAIT_MARKER') {
      if (isFreq(PROTOCOL.MARKER_FREQ)) {
        d.consecutiveFrames++;
        if (d.consecutiveFrames > 2) { // Debounce
          d.state = 'READ_CHAR';
          d.consecutiveFrames = 0;
          if (!isReceiving) setIsReceiving(true);
        }
      }
    } 
    else if (d.state === 'READ_CHAR') {
      // Identify character frequency
      if (!isFreq(PROTOCOL.MARKER_FREQ)) {
        const estimatedChar = Math.round((freq - PROTOCOL.BASE_FREQ) / PROTOCOL.STEP_FREQ);
        
        if (estimatedChar >= 32 && estimatedChar <= 126) {
           d.consecutiveFrames++;
           
           if (d.consecutiveFrames > 3) {
             const char = String.fromCharCode(estimatedChar);
             
             if (char !== d.lastDetectedChar) {
               d.buffer += char;
               setIncomingBuffer(d.buffer); // Update UI
               d.lastDetectedChar = char;
               d.state = 'WAIT_MARKER'; 
               d.consecutiveFrames = 0;
               d.silenceTimer = now;
             }
           }
        }
      } else {
         d.consecutiveFrames = 0;
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
          
          {/* Signal Meter */}
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <div className="text-xs text-blue-100">FREQ</div>
              <div className="text-sm font-bold text-white font-mono">{signalStrength > 10 ? 'DETECT' : 'LOW'}</div>
            </div>
            {/* Visualizer */}
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
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={micPermission ? "Enter text to transmit..." : isSecureContext ? "Enable microphone first" : "HTTPS Required"}
              disabled={!micPermission || isSending}
              className="flex-1 bg-gray-800 text-white px-3 sm:px-4 py-2 sm:py-3 rounded-xl border border-gray-600 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base transition-all font-mono"
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