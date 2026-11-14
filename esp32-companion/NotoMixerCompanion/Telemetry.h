#pragma once

#include <Arduino.h>

constexpr size_t PeakCapacity = 6000;
constexpr size_t TitleCapacity = 80;
constexpr size_t DeckStateWireSize = 148;
constexpr size_t StateWireSize = 4 + 2 * DeckStateWireSize;
// The desktop sends at most one populated waveform per update.
constexpr size_t FrameWireSize = StateWireSize + 2 * PeakCapacity;

struct Deck {
  bool loaded;
  bool playing;
  bool colored;
  bool looping;
  bool endingWarning;
  bool endSyncCountdown;
  uint16_t peakCount;
  float position;
  float duration;
  float rate;
  float bpm;
  float sourceBpm;
  float beatOffset;
  float loopStart;
  float loopEnd;
  float cues[8];
  char title[TitleCapacity];
  uint16_t peaks[PeakCapacity];
};

struct Snapshot {
  Deck decks[2];
  uint32_t receivedAt;
  uint32_t sampledAt;
};

inline float readWireFloat(const uint8_t* data) {
  uint32_t bits = uint32_t(data[0]) | (uint32_t(data[1]) << 8)
    | (uint32_t(data[2]) << 16) | (uint32_t(data[3]) << 24);
  float value;
  memcpy(&value, &bits, sizeof(value));
  return isfinite(value) ? value : 0.0f;
}

inline bool decodeFrame(const uint8_t* data, size_t size, bool haveFullFrame, Snapshot& snapshot) {
  if (size < StateWireSize || memcmp(data, "NM05", 4) != 0) return false;
  uint16_t counts[2];
  size_t expectedSize = StateWireSize;
  for (size_t i = 0; i < 2; ++i) {
    const uint8_t* record = data + 4 + i * DeckStateWireSize;
    const bool loaded = (record[0] & 1) != 0;
    const bool colored = (record[0] & 4) != 0;
    const bool replaced = (record[0] & 16) != 0;
    const size_t count = record[2] | (uint16_t(record[3]) << 8);
    if (count > PeakCapacity || (!loaded && count != 0)) return false;
    if (replaced) expectedSize += count * (colored ? 2 : 1);
    else if (!haveFullFrame || count != snapshot.decks[i].peakCount
        || colored != snapshot.decks[i].colored) return false;
    counts[i] = count;
  }
  if (size != expectedSize) return false;
  const uint8_t* payload = data + StateWireSize;
  for (size_t i = 0; i < 2; ++i) {
    const uint8_t* record = data + 4 + i * DeckStateWireSize;
    Deck& deck = snapshot.decks[i];
    deck.loaded = (record[0] & 1) != 0;
    deck.playing = deck.loaded && (record[0] & 2) != 0;
    deck.colored = (record[0] & 4) != 0;
    deck.looping = deck.loaded && (record[0] & 8) != 0;
    deck.endingWarning = deck.playing && (record[0] & 32) != 0;
    deck.endSyncCountdown = deck.loaded && (record[0] & 64) != 0;
    deck.peakCount = counts[i];
    deck.position = max(0.0f, readWireFloat(record + 4));
    deck.duration = max(0.0f, readWireFloat(record + 8));
    deck.rate = deck.playing ? constrain(readWireFloat(record + 12), 0.0f, 8.0f) : 0.0f;
    deck.bpm = constrain(readWireFloat(record + 16), 0.0f, 999.9f);
    deck.sourceBpm = constrain(readWireFloat(record + 100), 0.0f, 999.9f);
    deck.beatOffset = readWireFloat(record + 104);
    deck.loopStart = readWireFloat(record + 108);
    deck.loopEnd = readWireFloat(record + 112);
    for (int cue = 0; cue < 8; ++cue) {
      deck.cues[cue] = deck.loaded ? readWireFloat(record + 116 + cue * 4) : -1.0f;
    }
    memcpy(deck.title, record + 20, TitleCapacity - 1);
    deck.title[TitleCapacity - 1] = '\0';
    if (record[0] & 16) {
      for (size_t point = 0; point < deck.peakCount; ++point) {
        uint16_t value = *payload++;
        if (deck.colored) value |= uint16_t(*payload++) << 8;
        deck.peaks[point] = value;
      }
    }
  }
  return true;
}
