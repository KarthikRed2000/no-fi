import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, WifiOff, Activity, Lock, Inbox, X, Zap, Radio, Waves, Signal, MessageCircle } from 'lucide-react';

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
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const isSendingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<string>>(new Set(["SYS1"]));

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

  const generateId = () => Math.random().toString(36).substring(2, 6).toUpperCase();

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      
      setRelayQueue(prev => {
        if (isSendingRef.current || isReceiving) {
          return prev;
        }
        
        const toRelay = prev.filter(msg => 
          msg.status === 'pending' && 
          (now - msg.receivedAt.getTime()) >= msg.relayAfter
        );
        
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
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isReceiving]);

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

      osc.frequency.setValueAtTime(PROTOCOL.MARKER_FREQ, startTime);
      gain.gain.setValueAtTime(0.5, startTime);
      gain.gain.setValueAtTime(0.5, startTime + PROTOCOL.TONE_DURATION);
      gain.gain.linearRampToValueAtTime(0, startTime + PROTOCOL.TONE_DURATION + 0.005); 
      startTime += PROTOCOL.TONE_DURATION + PROTOCOL.GAP_DURATION;

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

  const handleFrequencyInput = (freq: number, amplitude: number) => {
    const d = decoderRef.current;
    const now = Date.now();

    if (d.buffer.length > 0 && (now - d.lastCharDecoded > 3000)) {
      addLog('No new char for 3s - committing', 'info');
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
      addLog('Signal lost (timeout)', 'info');
      return;
    }

    if (amplitude < PROTOCOL.THRESHOLD) {
      d.consecutiveFrames = 0;
      if (d.buffer.length > 0 && d.silenceTimer === null) {
        d.silenceTimer = now;
      }
      return;
    }

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
          d.lastDetectedChar = null;
          d.lastValidRead = now;
          if (!isReceiving) setIsReceiving(true);
        }
      } else {
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
               d.lastCharDecoded = now;
               d.state = 'WAIT_MARKER'; 
               d.consecutiveFrames = 0;
               d.lastValidRead = now;
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
    
    d.buffer = '';
    d.lastDetectedChar = null;
    d.state = 'IDLE';
    d.silenceTimer = null;
    d.lastCharDecoded = Date.now();
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
        * {
          -webkit-tap-highlight-color: transparent;
          -webkit-touch-callout: none;
        }
        
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(30px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-30px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes slideLeft {
          from { opacity: 0; transform: translateX(-40px) scale(0.9); }
          to { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes slideRight {
          from { opacity: 0; transform: translateX(40px) scale(0.9); }
          to { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes scaleIn {
          from { opacity: 0; transform: scale(0.8); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.95); }
        }
        @keyframes ripple {
          0% { transform: scale(0); opacity: 0.6; }
          100% { transform: scale(4); opacity: 0; }
        }
        @keyframes wave {
          0%, 100% { transform: scaleY(0.3); }
          50% { transform: scaleY(1); }
        }
        @keyframes glow {
          0%, 100% { 
            box-shadow: 0 0 20px rgba(6, 182, 212, 0.3), 
                        0 0 40px rgba(59, 130, 246, 0.2),
                        0 0 60px rgba(168, 85, 247, 0.1);
          }
          50% { 
            box-shadow: 0 0 40px rgba(6, 182, 212, 0.5), 
                        0 0 80px rgba(59, 130, 246, 0.3),
                        0 0 120px rgba(168, 85, 247, 0.2);
          }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          33% { transform: translateY(-12px) rotate(1deg); }
          66% { transform: translateY(-8px) rotate(-1deg); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes particles {
          0% { transform: translateY(0) translateX(0); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(-100px) translateX(20px); opacity: 0; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes gradientFlow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        .animate-slideUp { animation: slideUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        .animate-slideDown { animation: slideDown 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        .animate-slideLeft { animation: slideLeft 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        .animate-slideRight { animation: slideRight 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        .animate-fadeIn { animation: fadeIn 0.4s ease-out forwards; }
        .animate-scaleIn { animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        .animate-pulse { animation: pulse 2s ease-in-out infinite; }
        .animate-wave { animation: wave 0.8s ease-in-out infinite; }
        .animate-glow { animation: glow 3s ease-in-out infinite; }
        .animate-float { animation: float 6s ease-in-out infinite; }
        .animate-spin { animation: spin 2s linear infinite; }
        .animate-gradientFlow { 
          background-size: 200% 200%;
          animation: gradientFlow 3s ease infinite;
        }
        
        .glass-ultra {
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(40px) saturate(180%);
          -webkit-backdrop-filter: blur(40px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 
            0 8px 32px 0 rgba(0, 0, 0, 0.37),
            inset 0 1px 1px 0 rgba(255, 255, 255, 0.1);
        }
        
        .glass-card {
          background: linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.1) 0%,
            rgba(255, 255, 255, 0.05) 100%
          );
          backdrop-filter: blur(30px) saturate(150%);
          -webkit-backdrop-filter: blur(30px) saturate(150%);
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 
            0 10px 40px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.2);
        }
        
        .message-glow-send {
          box-shadow: 
            0 0 20px rgba(6, 182, 212, 0.4),
            0 10px 30px rgba(6, 182, 212, 0.2);
        }
        
        .message-glow-receive {
          box-shadow: 
            0 0 20px rgba(34, 197, 94, 0.4),
            0 10px 30px rgba(34, 197, 94, 0.2);
        }
        
        .shimmer-effect {
          position: relative;
          overflow: hidden;
        }
        .shimmer-effect::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.2),
            transparent
          );
          animation: shimmer 2s infinite;
        }
        
        .particle {
          position: absolute;
          width: 4px;
          height: 4px;
          background: radial-gradient(circle, rgba(6, 182, 212, 0.8), transparent);
          border-radius: 50%;
          pointer-events: none;
          animation: particles 3s ease-out forwards;
        }
        
        .gradient-border {
          position: relative;
          background: linear-gradient(135deg, #06b6d4, #3b82f6, #a855f7);
          padding: 2px;
          border-radius: 1rem;
        }
        
        .gradient-border > * {
          background: #000;
          border-radius: calc(1rem - 2px);
        }
        
        .mesh-gradient {
          background: 
            radial-gradient(at 15% 20%, rgba(6, 182, 212, 0.25) 0px, transparent 50%),
            radial-gradient(at 85% 30%, rgba(59, 130, 246, 0.2) 0px, transparent 50%),
            radial-gradient(at 50% 70%, rgba(168, 85, 247, 0.15) 0px, transparent 50%),
            radial-gradient(at 90% 80%, rgba(34, 197, 94, 0.15) 0px, transparent 50%),
            linear-gradient(135deg, #000000 0%, #0a0a1a 50%, #000000 100%);
          background-size: 200% 200%;
          animation: gradientFlow 10s ease infinite;
        }
        
        .bounce-in {
          animation: bounceIn 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }
        
        @keyframes bounceIn {
          0% { transform: scale(0) rotate(0deg); }
          50% { transform: scale(1.1) rotate(5deg); }
          100% { transform: scale(1) rotate(0deg); }
        }
        
        /* Mobile optimizations */
        @media (max-width: 640px) {
          .glass-ultra, .glass-card {
            backdrop-filter: blur(20px) saturate(150%);
            -webkit-backdrop-filter: blur(20px) saturate(150%);
          }
        }
        
        /* Smooth scrolling */
        * {
          scroll-behavior: smooth;
        }
        
        /* Custom scrollbar */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.2);
          border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, #06b6d4, #3b82f6);
          border-radius: 10px;
          transition: all 0.3s ease;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, #0891b2, #2563eb);
        }
        
        /* Input focus glow */
        .input-glow:focus {
          box-shadow: 
            0 0 0 3px rgba(6, 182, 212, 0.2),
            0 0 20px rgba(6, 182, 212, 0.3),
            inset 0 0 10px rgba(6, 182, 212, 0.1);
        }
        
        /* Button press effect */
        .btn-press:active {
          transform: scale(0.95);
          transition: transform 0.1s ease;
        }
      `}</style>

      {/* Onboarding Modal */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-2xl animate-fadeIn" />
          
          <div className="relative glass-ultra rounded-[2rem] p-8 sm:p-12 w-full max-w-md shadow-2xl animate-float border-2 border-cyan-500/20">
            {/* Floating particles effect */}
            <div className="absolute inset-0 overflow-hidden rounded-[2rem] pointer-events-none">
              {[...Array(12)].map((_, i) => (
                <div
                  key={i}
                  className="particle"
                  style={{
                    left: `${Math.random() * 100}%`,
                    animationDelay: `${i * 0.3}s`,
                    animationDuration: `${3 + Math.random() * 2}s`
                  }}
                />
              ))}
            </div>
            
            <div className="flex justify-center mb-10 relative z-10">
              <div className="relative animate-glow">
                <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 rounded-full blur-3xl opacity-60 animate-pulse" />
                <div className="relative glass-card p-8 rounded-3xl border-2 border-cyan-400/50 animate-float">
                  <WifiOff className="w-16 h-16 sm:w-20 sm:h-20 text-cyan-400" strokeWidth={2.5} />
                  <div className="absolute -bottom-2 -right-2 glass-card p-2 rounded-full border border-blue-400/50">
                    <Radio className="w-6 h-6 text-blue-400 animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
            
            <h2 className="text-4xl sm:text-5xl font-black text-center mb-4 bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent animate-gradientFlow relative z-10">
              NoFi Modem
            </h2>
            
            <p className="text-center text-cyan-100/90 mb-3 text-base sm:text-lg px-4 font-medium relative z-10">
              Audio-based mesh network
            </p>
            
            <div className="glass-card rounded-2xl p-5 mb-8 border border-cyan-500/30 shimmer-effect relative z-10">
              <div className="flex items-start gap-4 text-sm text-cyan-50">
                <Zap className="w-6 h-6 text-yellow-400 flex-shrink-0 mt-0.5 animate-pulse" />
                <div className="space-y-2">
                  <p className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    P2P audio communication
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                    Auto-relay (10-20s random)
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                    Mesh network routing
                  </p>
                </div>
              </div>
            </div>

            {!isSecureContext && (
              <div className="bg-gradient-to-r from-red-900/50 to-red-800/50 border-2 border-red-500/60 rounded-2xl p-5 mb-8 text-sm text-red-200 flex items-start gap-3 glass-card animate-slideDown relative z-10">
                <Lock className="w-6 h-6 flex-shrink-0 mt-0.5 text-red-400 animate-pulse" />
                <div>
                  <strong className="block mb-2 text-base">🔒 Security Required</strong>
                  HTTPS is required to access your microphone for audio transmission.
                </div>
              </div>
            )}
            
            <button
              onClick={requestMicPermission}
              disabled={!isSecureContext}
              className="relative w-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 hover:from-cyan-600 hover:via-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-800 disabled:cursor-not-allowed text-white font-bold py-5 px-8 rounded-2xl transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:hover:scale-100 flex items-center justify-center gap-3 shadow-2xl text-lg overflow-hidden btn-press z-10 shimmer-effect"
            >
              <Mic className="w-7 h-7" />
              <span>{isSecureContext ? 'Activate Modem' : 'HTTPS Required'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Relay Queue Panel */}
      {showRelayQueue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/85 backdrop-blur-2xl animate-fadeIn" 
            onClick={() => setShowRelayQueue(false)} 
          />
          
          <div className="relative glass-ultra rounded-[2rem] p-6 sm:p-8 w-full max-w-3xl border-2 border-green-500/30 max-h-[90vh] flex flex-col shadow-2xl animate-scaleIn">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl sm:text-3xl font-black bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent flex items-center gap-3">
                <div className="relative">
                  <Inbox className="w-8 h-8 text-green-400" />
                  {relayQueue.filter(m => m.status === 'pending').length > 0 && (
                    <span className="absolute -top-2 -right-2 w-5 h-5 bg-green-500 rounded-full animate-pulse" />
                  )}
                </div>
                Relay Queue
              </h2>
              <button
                onClick={() => setShowRelayQueue(false)}
                className="glass-card hover:bg-white/10 p-3 rounded-xl transition-all transform hover:scale-110 active:scale-95 btn-press"
              >
                <X className="w-6 h-6 text-gray-300" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-3 mb-6 pr-2">
              {relayQueue.length === 0 ? (
                <div className="text-center text-gray-400 py-20 animate-fadeIn">
                  <div className="relative inline-block">
                    <Inbox className="w-20 h-20 mx-auto mb-6 opacity-20" />
                    <Waves className="w-12 h-12 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-cyan-500/30 animate-pulse" />
                  </div>
                  <p className="text-xl font-semibold">No messages queued</p>
                  <p className="text-sm mt-2 text-gray-500">Received messages will appear here</p>
                </div>
              ) : (
                relayQueue.map((msg, idx) => (
                  <div
                    key={msg.id}
                    className={`glass-card rounded-2xl p-5 border-2 transition-all transform hover:scale-[1.01] animate-slideUp ${
                      msg.status === 'relayed' 
                        ? 'border-gray-600/50 opacity-60' 
                        : 'border-green-500/60 hover:border-green-400'
                    }`}
                    style={{ animationDelay: `${idx * 0.08}s` }}
                  >
                    <div className="flex items-start justify-between gap-4 flex-col sm:flex-row">
                      <div className="flex-1 w-full">
                        <p className="text-white mb-4 text-base break-words leading-relaxed">{msg.text}</p>
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                          <span className="glass-card px-3 py-1.5 rounded-lg font-mono font-bold text-cyan-300 border border-cyan-500/30">
                            #{msg.id}
                          </span>
                          <span className="flex items-center gap-2 text-gray-400">
                            <Activity className="w-4 h-4" />
                            {msg.receivedAt.toLocaleTimeString()}
                          </span>
                          <span className={`px-3 py-1.5 rounded-lg font-bold ${
                            msg.status === 'relayed' 
                              ? 'bg-gray-700/50 text-gray-300 border border-gray-600' 
                              : 'bg-green-600/30 text-green-300 border border-green-500/50 animate-pulse'
                          }`}>
                            {msg.status === 'relayed' ? '✓ Relayed' : '⏳ Pending'}
                          </span>
                        </div>
                      </div>
                      {msg.status === 'pending' && (
                        <button
                          onClick={() => relayMessage(msg.id)}
                          disabled={isSending}
                          className="w-full sm:w-auto bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:from-gray-700 disabled:to-gray-800 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-bold transition-all transform hover:scale-105 active:scale-95 disabled:hover:scale-100 shadow-lg btn-press shimmer-effect"
                        >
                          Relay Now
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
                className="w-full glass-card hover:bg-red-500/20 border-2 border-red-500/60 text-red-400 hover:text-red-300 py-4 rounded-xl transition-all font-bold transform hover:scale-[1.02] active:scale-[0.98] btn-press"
              >
                Clear All Messages
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Chat Interface */}
      <div className="h-screen w-full mesh-gradient flex flex-col overflow-hidden relative">
        
        {/* Header */}
        <div className="relative glass-ultra border-b border-white/10 shadow-2xl z-20 animate-slideDown">
          <div className="p-4 sm:p-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="relative flex-shrink-0">
                <div className={`absolute inset-0 rounded-2xl blur-xl transition-all ${isSending || isReceiving ? 'bg-cyan-500 animate-pulse' : 'bg-blue-500/40'}`} />
                <div className="relative glass-card rounded-2xl p-3 border-2 border-cyan-400/60 transition-all hover:scale-110 transform">
                  <WifiOff className="w-7 h-7 text-cyan-400" strokeWidth={3} />
                  {(isSending || isReceiving) && (
                    <div className="absolute -bottom-1 -right-1 glass-card p-1 rounded-full border-2 border-green-400">
                      <Activity className="w-3 h-3 text-green-400 animate-pulse" />
                    </div>
                  )}
                </div>
              </div>
              
              <div className="min-w-0 flex-1">
                <h1 className="text-xl sm:text-2xl lg:text-3xl font-black bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent flex items-center gap-2 flex-wrap animate-gradientFlow">
                  NoFi
                  <span className="glass-card text-[10px] sm:text-xs font-bold px-2 sm:px-3 py-1 rounded-full flex items-center gap-1.5 text-white border border-white/20 animate-pulse">
                    <Lock className={`w-3 h-3 ${isSecureContext ? 'text-green-400' : 'text-red-400'}`} />
                    <span className="hidden sm:inline">{isSecureContext ? 'Secure' : 'Insecure'}</span>
                  </span>
                </h1>
                <p className="text-xs text-cyan-300 font-mono font-bold mt-1 flex items-center gap-2">
                  {isSending ? (
                    <>
                      <Signal className="w-3 h-3 animate-pulse" />
                      TX: SENDING
                    </>
                  ) : isReceiving ? (
                    <>
                      <Signal className="w-3 h-3 animate-pulse" />
                      RX: DECODING
                    </>
                  ) : (
                    <>
                      <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      IDLE
                    </>
                  )}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setShowRelayQueue(true)}
                className="relative glass-card hover:bg-white/10 p-3 rounded-xl transition-all border border-white/10 group transform hover:scale-110 active:scale-95 btn-press"
              >
                <Inbox className="w-5 h-5 sm:w-6 sm:h-6 text-cyan-300 group-hover:text-cyan-200 transition-colors" />
                {relayQueue.filter(m => m.status === 'pending').length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-gradient-to-r from-green-500 to-emerald-500 text-white text-xs w-6 h-6 rounded-full flex items-center justify-center font-black shadow-lg animate-pulse border-2 border-gray-900">
                    {relayQueue.filter(m => m.status === 'pending').length}
                  </span>
                )}
              </button>
              
              <div className="hidden sm:flex items-center gap-3 glass-card px-4 py-2.5 rounded-xl border border-white/10">
                <div className="flex gap-1">
                  {[...Array(6)].map((_, i) => (
                    <div 
                      key={i}
                      className="w-1.5 bg-gradient-to-t from-cyan-400 to-blue-400 rounded-full transition-all duration-150 animate-wave shadow-lg"
                      style={{ 
                        height: `${Math.min(32, Math.max(6, audioLevel * (0.8 + Math.sin(i + Date.now()/100) * 0.4)))}px`,
                        opacity: micPermission ? 1 : 0.2,
                        animationDelay: `${i * 0.12}s`
                      }} 
                    />
                  ))}
                </div>
                <div className="text-right">
                  <div className="text-[9px] text-cyan-300/70 uppercase tracking-widest font-bold">Signal</div>
                  <div className="text-sm font-black text-white font-mono">{signalStrength > 10 ? 'ACTIVE' : 'LOW'}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          
          {isSending && (
            <div className="absolute inset-0 pointer-events-none z-20">
              <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-blue-500/10 to-purple-500/5 animate-pulse" />
              <div className="absolute top-0 left-0 w-full h-1">
                <div className="h-full bg-gradient-to-r from-transparent via-cyan-500 to-transparent animate-pulse shadow-lg" />
              </div>
            </div>
          )}

          {isReceiving && (
             <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-30 animate-bounceIn max-w-[90%]">
                <div className="glass-ultra px-6 sm:px-8 py-4 sm:py-5 rounded-2xl border-2 border-green-500/60 shadow-2xl">
                  <div className="flex flex-col items-center gap-3">
                    <span className="text-green-400 text-xs font-mono uppercase tracking-widest flex items-center gap-2 font-bold">
                      <Activity className="w-5 h-5 animate-pulse" />
                      <span className="hidden sm:inline">Decoding Audio Stream</span>
                      <span className="sm:hidden">Decoding...</span>
                    </span>
                    <div className="glass-card px-4 py-2 rounded-xl border border-green-500/30">
                      <span className="text-white font-mono text-lg sm:text-xl font-bold flex items-center">
                        {incomingBuffer || '_'}
                        <span className="animate-pulse ml-1 text-green-400">█</span>
                      </span>
                    </div>
                  </div>
                </div>
             </div>
          )}

          {logs.length > 0 && (
            <div className="absolute top-4 right-4 glass-ultra rounded-2xl p-4 border border-cyan-500/40 z-10 max-w-xs shadow-2xl pointer-events-none hidden lg:block animate-slideDown">
              <div className="text-xs font-mono space-y-2.5">
                {logs.map((log, idx) => (
                  <div 
                    key={idx}
                    className={`flex items-start gap-2 animate-fadeIn ${
                      log.type === 'error' ? 'text-red-400' : 
                      log.type === 'success' ? 'text-green-400' : 
                      'text-cyan-400'
                    }`}
                    style={{ animationDelay: `${idx * 0.1}s` }}
                  >
                    <span className="text-gray-500 flex-shrink-0 font-bold">[{log.timestamp}]</span>
                    <span className="flex-1 font-semibold">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 pb-28">
            {messages.map((message, idx) => (
              <div
                key={message.id}
                className={`flex ${message.sender === 'me' ? 'justify-end' : message.sender === 'system' ? 'justify-center' : 'justify-start'} ${
                  message.sender === 'me' ? 'animate-slideRight' : 
                  message.sender === 'system' ? 'animate-scaleIn' : 
                  'animate-slideLeft'
                }`}
                style={{ animationDelay: `${idx * 0.06}s` }}
              >
                <div
                  className={`max-w-[85%] sm:max-w-md px-5 py-4 rounded-3xl shadow-2xl transition-all transform hover:scale-[1.02] ${
                    message.sender === 'me'
                      ? 'bg-gradient-to-br from-cyan-500 via-blue-500 to-blue-600 text-white rounded-br-lg border-2 border-cyan-400/40 message-glow-send'
                      : message.sender === 'system'
                      ? 'glass-ultra border-2 border-cyan-500/30 text-cyan-100 text-center text-sm px-6 py-3'
                      : 'glass-card text-white rounded-bl-lg border-2 border-green-500/50 message-glow-receive'
                  }`}
                >
                  <p className="text-sm sm:text-base break-words leading-relaxed mb-2 font-medium">{message.text}</p>
                  {message.sender !== 'system' && (
                    <div className="flex items-center justify-between pt-2 mt-2 border-t border-white/10 gap-4 text-[10px] opacity-70">
                      <span className="font-mono font-bold flex items-center gap-1">
                        <MessageCircle className="w-3 h-3" />
                        #{message.id}
                      </span>
                      <span className="font-mono font-semibold">
                        {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {message.sender === 'other' && ' • RX'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area */}
        <div className="relative glass-ultra border-t border-white/10 shadow-2xl z-20 animate-slideUp safe-area-bottom">
          <div className="p-4 sm:p-5">
            <div className="flex items-center gap-3 max-w-5xl mx-auto">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={micPermission ? "Type message..." : isSecureContext ? "Enable mic first" : "HTTPS Required"}
                disabled={!micPermission || isSending}
                className="flex-1 glass-card text-white px-5 py-4 rounded-2xl border-2 border-cyan-500/40 focus:border-cyan-400/80 outline-none disabled:opacity-40 disabled:cursor-not-allowed text-base transition-all font-medium placeholder-gray-400 input-glow"
              />
              <button
                onClick={sendMessage}
                disabled={!inputText.trim() || !micPermission || isSending}
                className="bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 hover:from-cyan-600 hover:via-blue-600 hover:to-purple-600 disabled:from-gray-800 disabled:to-gray-900 disabled:cursor-not-allowed text-white p-4 rounded-2xl transition-all transform hover:scale-110 active:scale-95 disabled:hover:scale-100 disabled:opacity-40 shadow-2xl flex-shrink-0 border-2 border-white/20 btn-press shimmer-effect"
              >
                <Send className="w-6 h-6" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default NoFiChat;