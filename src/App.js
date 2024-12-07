import React, { useState, useRef, useEffect } from 'react';
import './App.css';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 2000;
const CHANNELS = 1;

// Audio chunk buffer class to manage smooth playback
class AudioChunkBuffer {
  constructor(bufferSize = 4) {
    this.chunks = [];
    this.bufferSize = bufferSize;
    this.isPlaying = false;
  }

  addChunk(chunk) {
    this.chunks.push(chunk);
    return this.chunks.length >= this.bufferSize;
  }

  getNextChunk() {
    return this.chunks.shift();
  }

  hasChunks() {
    return this.chunks.length > 0;
  }

  reset() {
    this.chunks = [];
    this.isPlaying = false;
  }
}

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [temperatures, setTemperatures] = useState({
    token_temp: 0.8,
    categorical_temp: 0.4,
    gaussian_temp: 0.1
  });
  
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorNodeRef = useRef(null);
  const playbackNodeRef = useRef(null);
  const chunkBufferRef = useRef(new AudioChunkBuffer(4));
  const audioBufferRef = useRef(new Float32Array(0));

  const startContinuousPlayback = () => {
    if (!audioContextRef.current) return;

    const playbackProcessor = audioContextRef.current.createScriptProcessor(2048, 1, 1);
    playbackNodeRef.current = playbackProcessor;

    let currentChunk = null;
    let chunkPosition = 0;

    playbackProcessor.onaudioprocess = (e) => {
      const outputBuffer = e.outputBuffer.getChannelData(0);

      for (let i = 0; i < 2048; i++) {
        if (!currentChunk || chunkPosition >= currentChunk.length) {
          if (chunkBufferRef.current.hasChunks()) {
            currentChunk = chunkBufferRef.current.getNextChunk();
            chunkPosition = 0;
          } else {
            outputBuffer[i] = 0;
            continue;
          }
        }
        outputBuffer[i] = currentChunk[chunkPosition++];
      }
    };

    playbackProcessor.connect(audioContextRef.current.destination);
    chunkBufferRef.current.isPlaying = true;
  };

  const handleStart = async () => {
    try {
      // Use wss-proxy.fly.dev as WebSocket proxy
      const wsUrl = window.location.protocol === 'https:' 
        ? `wss://wss-proxy.fly.dev/proxy?url=ws://185.113.122.75:49518/audio`
        : 'ws://185.113.122.75:49518/audio';
      
      wsRef.current = new WebSocket(wsUrl);
      
      // Add connection error handling
      wsRef.current.onerror = (error) => {
        console.error('WebSocket Error:', error);
        alert('Connection failed. Please try again.');
      };
      
      // Initialize Audio Context
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE
      });
      
      // Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: CHANNELS,
          sampleRate: SAMPLE_RATE
        } 
      });
      mediaStreamRef.current = stream;
      
      // Create audio source
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      // Create ScriptProcessor for input
      const processor = audioContextRef.current.createScriptProcessor(4096, CHANNELS, CHANNELS);
      processorNodeRef.current = processor;
      
      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Append new data to our buffer
          const newBuffer = new Float32Array(audioBufferRef.current.length + inputData.length);
          newBuffer.set(audioBufferRef.current);
          newBuffer.set(inputData, audioBufferRef.current.length);
          audioBufferRef.current = newBuffer;
          
          // While we have enough samples, send chunks
          while (audioBufferRef.current.length >= BUFFER_SIZE) {
            const chunk = audioBufferRef.current.slice(0, BUFFER_SIZE);
            audioBufferRef.current = audioBufferRef.current.slice(BUFFER_SIZE);
            
            const intData = new Int16Array(BUFFER_SIZE);
            for (let i = 0; i < BUFFER_SIZE; i++) {
              intData[i] = chunk[i] * 32767;
            }
            
            const base64Data = btoa(String.fromCharCode(...new Uint8Array(intData.buffer)));
            wsRef.current.send(`data:audio/raw;base64,${base64Data}`);
          }
        }
      };
      
      // Connect input nodes
      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      // Handle incoming audio data
      wsRef.current.onmessage = async (event) => {
        const base64Audio = event.data.split(',')[1];
        const audioData = new Int16Array(
          new Uint8Array(
            atob(base64Audio)
              .split('')
              .map(char => char.charCodeAt(0))
          ).buffer
        );
        
        // Convert to float32 for audio playback
        const floatData = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          floatData[i] = audioData[i] / 32767.0;
        }
        
        // Add to buffer and check if we should start playback
        if (chunkBufferRef.current.addChunk(floatData) && !chunkBufferRef.current.isPlaying) {
          startContinuousPlayback();
        }
      };
      
      setIsConnected(true);
    } catch (error) {
      console.error('Error starting audio stream:', error);
    }
  };

  const handleStop = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
    }
    if (playbackNodeRef.current) {
      playbackNodeRef.current.disconnect();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    chunkBufferRef.current.reset();
    audioBufferRef.current = new Float32Array(0);
    setIsConnected(false);
  };

  const handleTemperatureChange = async (e) => {
    const { name, value } = e.target;
    const floatValue = parseFloat(value);
    const newTemperatures = { ...temperatures, [name]: floatValue };
    setTemperatures(newTemperatures);
    
    try {
      const url = new URL(`${window.location.origin}/api/set_temperature`);
      url.searchParams.append('token_temp', newTemperatures.token_temp);
      url.searchParams.append('categorical_temp', newTemperatures.categorical_temp);
      url.searchParams.append('gaussian_temp', newTemperatures.gaussian_temp);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log('Temperature update response:', data);
    } catch (error) {
      console.error('Error updating temperature:', error);
    }
  };

  useEffect(() => {
    return () => {
      handleStop();
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Audio Inference Client</h1>
        
        <div className="controls">
          <button 
            onClick={isConnected ? handleStop : handleStart}
            className={isConnected ? 'stop' : 'start'}
          >
            {isConnected ? 'Stop' : 'Start'}
          </button>
        </div>

        <div className="temperature-controls">
          <h2>Temperature Controls</h2>
          <div className="temp-input">
            <label>Token Temperature:</label>
            <input
              type="number"
              name="token_temp"
              min="0"
              max="2"
              step="0.1"
              value={temperatures.token_temp}
              onChange={handleTemperatureChange}
            />
          </div>
          <div className="temp-input">
            <label>Categorical Temperature:</label>
            <input
              type="number"
              name="categorical_temp"
              min="0"
              max="2"
              step="0.1"
              value={temperatures.categorical_temp}
              onChange={handleTemperatureChange}
            />
          </div>
          <div className="temp-input">
            <label>Gaussian Temperature:</label>
            <input
              type="number"
              name="gaussian_temp"
              min="0"
              max="2"
              step="0.1"
              value={temperatures.gaussian_temp}
              onChange={handleTemperatureChange}
            />
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;
