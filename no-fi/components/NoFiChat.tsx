import React, { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Signal, WifiOff, Repeat } from 'lucide-react';

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

const NoFiChat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: 1, text: "Welcome to NoFi! Your messages are transmitted via sound waves.", sender: "system", timestamp: new Date() }
  ]);
  const [inputText, setInputText] = useState<string>('');
  const [logs, setLogs] = useState<Log[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(true);
  const [micPermission, setMicPermission] = useState<boolean>(false);
  
  // Transmission States
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isReceiving, setIsReceiving] = useState<boolean>(false);
  
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

  // FIX: Inject Tailwind CSS dynamically to ensure styles load
  useEffect(() => {
    if (!document.querySelector('script[src*="tailwindcss"]')) {
      const script = document.createElement('script');
      script.src = "https://cdn.tailwindcss.com";
      script.async = true;
      document.head.appendChild(script);
    }
  }, []);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Background Process: Listen for foreign signals and relay them
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];

    // Logic: If we received a message from 'other', we act as a mesh node and forward it.
    // We do NOT forward our own messages (sender: 'me') here, as that's handled by sendMessage().
    // We do NOT forward 'system' messages.
    if (lastMessage && lastMessage.sender === 'other') {
      
      // Add a random delay to simulate processing/network slotting
      const processingDelay = Math.random() * 1500 + 500;

      const timer = setTimeout(() => {
        // Start Relay Process
        setIsRelaying(true);
        addLog('Background: Re-broadcasting signal...', 'info');

        // Relay Duration (transmit time)
        setTimeout(() => {
          setIsRelaying(false);
          setRelayCount(prev => prev + 1);
          addLog(`Background: Packet forwarded (Hops: ${Math.floor(Math.random() * 3) + 1})`, 'success');
        }, 1500);

      }, processingDelay);

      return () => clearTimeout(timer);
    }
  }, [messages]);

  // Add log entry
  const addLog = (message: string, type: 'info' | 'success' | 'error' = 'info'): void => {
    const logEntry: Log = { message, type, timestamp: new Date().toLocaleTimeString() };
    setLogs(prev => [...prev.slice(-4), logEntry]);
  };

  // Request microphone permission
  const requestMicPermission = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream; // Store stream to stop tracks later
      setMicPermission(true);
      setShowOnboarding(false);
      addLog('Microphone access granted', 'success');
      
      // Setup audio analysis for signal meter
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
      
      analyserRef.current = audioContextRef.current.createAnalyser();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      analyserRef.current.fftSize = 256;
      
      startAudioMonitoring();
    } catch (err) {
      addLog('Microphone access denied', 'error');
      console.error('Microphone error:', err);
    }
  };

  // Monitor audio levels for signal meter
  const startAudioMonitoring = (): void => {
    if (!analyserRef.current) return;
    
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const updateLevel = (): void => {
      if (!analyserRef.current) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      
      // Normalize to 0-100 range roughly
      const normalizedLevel = Math.min(100, (average / 128) * 100);
      
      setAudioLevel(normalizedLevel);
      setSignalStrength(Math.floor(normalizedLevel));
      
      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };
    
    updateLevel();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop animation loop
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }

      // Stop all microphone tracks
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Send message with animation
  const sendMessage = (): void => {
    if (!inputText.trim() || !micPermission) return;
    
    const newMessage: Message = {
      id: Date.now(),
      text: inputText,
      sender: 'me',
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, newMessage]);
    setInputText('');
    
    // Transmission animation sequence
    setIsSending(true);
    addLog('Encoding message...', 'info');
    
    setTimeout(() => {
      addLog('Modulating carrier wave...', 'info');
    }, 500);
    
    setTimeout(() => {
      addLog('Transmitting signal...', 'success');
    }, 1000);
    
    setTimeout(() => {
      setIsSending(false);
      addLog('Transmission complete', 'success');
      
      // Simulate receiving response (for demo)
      simulateReceive();
    }, 2000);
  };

  // Simulate receiving a message (for demo purposes)
  const simulateReceive = (): void => {
    setTimeout(() => {
      setIsReceiving(true);
      addLog('Detecting signal...', 'info');
      
      setTimeout(() => {
        addLog('Demodulating...', 'info');
      }, 500);
      
      setTimeout(() => {
        addLog('Decoding message...', 'info');
      }, 1000);
      
      setTimeout(() => {
        const responses: string[] = [
          "Message received via acoustic channel!",
          "Cool! This is working without WiFi!",
          "The sound transmission is pretty neat",
          "No internet, no problem! 🎵",
          "Relaying from node 0xA4...",
          "Can you hear me over the noise?"
        ];
        
        const responseMessage: Message = {
          id: Date.now(),
          text: responses[Math.floor(Math.random() * responses.length)],
          sender: 'other',
          timestamp: new Date()
        };
        
        setMessages(prev => [...prev, responseMessage]);
        setIsReceiving(false);
        addLog('Message decoded successfully', 'success');
      }, 1500);
    }, 3000);
  };

  // Handle Enter key
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
              Welcome to NoFi
            </h2>
            
            <p className="text-gray-300 text-center mb-6">
              Chat without WiFi or cellular data. Your messages travel through sound waves using acoustic transmission.
            </p>
            
            <div className="bg-blue-900 bg-opacity-30 border border-blue-500 rounded-lg p-4 mb-6">
              <p className="text-sm text-blue-200">
                <strong>📱 Microphone Required</strong><br />
                NoFi needs microphone access to send and receive messages via sound.
              </p>
            </div>
            
            <button
              onClick={requestMicPermission}
              className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-3 px-6 rounded-lg transition-all transform hover:scale-105 flex items-center justify-center gap-2"
            >
              <Mic className="w-5 h-5" />
              Allow Microphone Access
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
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                  <span className="text-white text-xs font-bold">/</span>
                </div>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">NoFi</h1>
                <p className="text-xs text-blue-100">Acoustic Mesh Network</p>
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
              <div className="text-xs text-blue-100">Signal</div>
              <div className="text-sm font-bold text-white">{signalStrength}%</div>
            </div>
            <div className="w-24 sm:w-32 h-2 bg-gray-700 rounded-full overflow-hidden border border-gray-600">
              <div 
                className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all duration-100"
                style={{ width: `${audioLevel}%` }}
              />
            </div>
            {micPermission ? (
              <Mic className="w-6 h-6 text-green-400" />
            ) : (
              <MicOff className="w-6 h-6 text-red-400" />
            )}
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          
          {/* Transmission Effect Overlay (Sending - Blue) */}
          {isSending && (
            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
              <div className="absolute inset-0 bg-blue-500 opacity-10 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-32 h-32 border-4 border-cyan-400 rounded-full animate-ping opacity-50" />
              </div>
            </div>
          )}

          {/* Relay Effect Overlay (Relaying - Amber) */}
          {isRelaying && (
            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
              <div className="absolute inset-0 bg-amber-500 opacity-5 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-48 h-48 border-2 border-amber-500/30 rounded-full animate-ping opacity-30" />
                <div className="absolute mt-32 text-amber-400/50 text-xs font-mono tracking-widest">RELAYING SIGNAL</div>
              </div>
            </div>
          )}

          {/* Log Window */}
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
            className={`flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 transition-colors duration-300 ${
              isReceiving ? 'shadow-[inset_0_0_20px_rgba(34,197,94,0.3)]' : ''
            }`}
            style={{
              background: isSending 
                ? 'radial-gradient(circle at center, rgba(59, 130, 246, 0.15) 0%, transparent 70%)'
                : 'transparent'
            }}
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
                      : 'bg-gray-700 text-white rounded-bl-none'
                  }`}
                >
                  <p className="text-sm break-words leading-relaxed">{message.text}</p>
                  <p className="text-[10px] opacity-70 mt-1 text-right">
                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
              placeholder={micPermission ? "Type your message..." : "Enable microphone first"}
              disabled={!micPermission}
              className="flex-1 bg-gray-800 text-white px-3 sm:px-4 py-2 sm:py-3 rounded-xl border border-gray-600 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base transition-all"
            />
            <button
              onClick={sendMessage}
              disabled={!inputText.trim() || !micPermission}
              className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed text-white p-2 sm:p-3 rounded-xl transition-all transform hover:scale-105 active:scale-95 disabled:hover:scale-100 shadow-lg flex-shrink-0"
            >
              <Send className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
          
          {!micPermission && (
            <p className="text-xs text-red-400 mt-2 flex items-center justify-center gap-1">
              <Signal className="w-3 h-3" />
              Microphone access required to send messages
            </p>
          )}
        </div>
      </div>
    </>
  );
};

export default NoFiChat;