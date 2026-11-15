#include <Arduino.h>
#include <mbedtls/base64.h>

#include "Browser.h"
#include "Display.h"
#include "Telemetry.h"

namespace {

constexpr uint32_t StaleMs = 2300;
constexpr char CompanionHello[] = "NM-COMPANION:7";
constexpr char WaveformPrefix[] = "NM-WAVEFORM:";
constexpr char LibraryPrefix[] = "NM-LIBRARY:";
constexpr char BrowserInputPrefix[] = "BROWSER:";
constexpr size_t MaxSerialLine = sizeof(WaveformPrefix) - 1 + 4 * ((FrameWireSize + 2) / 3);
constexpr float ViewSeconds = 8.0f;

constexpr uint32_t Background = 0x101620;
constexpr uint32_t Panel = 0x182231;
constexpr uint32_t EndingPulse[] = {0x16877C, 0xA95B28};
constexpr uint32_t Border = 0x2E3B4C;
constexpr uint32_t Text = 0xF0F5FA;
constexpr uint32_t Muted = 0xA3B3C6;
constexpr uint32_t Accent[] = {0x58DED4, 0xFFAD72};
constexpr uint32_t BandColor[] = {0x368AF2, 0xFF9D42, 0xF4EDCF};
constexpr uint32_t CueColor[] = {0xFF5680, 0xFFB84B, 0xECEA43, 0x5BEA71,
                                 0x45E9ED, 0x588AFF, 0xB768FF, 0xF260E8};
constexpr uint32_t Playhead = 0xFF3860;
constexpr uint32_t LoopFill = 0x286963;
constexpr uint32_t LoopEdge = 0x52EDD0;
constexpr int OverviewHeight = 19;
constexpr float DrawHz = 40.0f;
constexpr int DeckHeaderHeight = 28;
constexpr int HeaderRightWidth = 196;
constexpr int TransportIconWidth = 27;
constexpr uint32_t PlayFadePeriodMs = 1400;
constexpr int ShimmerRadius = 72;
constexpr uint32_t ShimmerPeriodMs = 1500;
constexpr uint32_t ShimmerBase = 0x171F2C;
constexpr uint32_t ShimmerHighlight = 0x34445A;

CompanionDisplay display;
lgfx::LGFX_Sprite waveform(&display);
lgfx::LGFX_Sprite headerRight(&display);
lgfx::LGFX_Sprite overview(&display);
QueueHandle_t snapshots;
QueueHandle_t browserPages;
Snapshot current{};
BrowserPage browser{};
int deckWidth;
int deckHeight;
int chartHeight;

void serialTask(void*) {
  static char line[MaxSerialLine + 1];
  static uint8_t frame[FrameWireSize];
  static Snapshot incoming{};
  static BrowserPage incomingBrowser{};
  size_t length = 0;
  bool overflow = false;
  bool haveFullFrame = false;
  uint32_t lineStartedAt = 0;
  uint32_t lastHello = millis() - 2000;
  Stream& port = CompanionUseNativeUsb ? static_cast<Stream&>(Serial) : static_cast<Stream&>(Serial0);

  for (;;) {
    while (port.available() > 0) {
      const int byte = port.read();
      if (byte < 0 || byte == '\r') continue;
      if (byte != '\n') {
        if (!length) lineStartedAt = millis();
        if (length < MaxSerialLine) line[length++] = char(byte);
        else overflow = true;
        continue;
      }

      line[length] = '\0';
      if (!overflow && strcmp(line, "CONN:1") == 0) {
        port.println(CompanionHello);
      } else if (!overflow && strcmp(line, "CONN:0") == 0) {
        haveFullFrame = false;
        incoming.receivedAt = 0;
        xQueueOverwrite(snapshots, &incoming);
        incomingBrowser.open = false;
        xQueueOverwrite(browserPages, &incomingBrowser);
      } else if (!overflow && strncmp(line, LibraryPrefix, sizeof(LibraryPrefix) - 1) == 0) {
        constexpr size_t prefix = sizeof(LibraryPrefix) - 1;
        size_t decodedSize = 0;
        if (mbedtls_base64_decode(frame, sizeof(frame), &decodedSize,
            reinterpret_cast<const unsigned char*>(line + prefix), length - prefix) == 0
            && decodeBrowserPage(frame, decodedSize, incomingBrowser)) {
          xQueueOverwrite(browserPages, &incomingBrowser);
        }
      } else if (!overflow && strncmp(line, BrowserInputPrefix, sizeof(BrowserInputPrefix) - 1) == 0) {
        if (length <= sizeof(BrowserInputPrefix) - 1 + 6) {
          port.print("NM-");
          port.println(line);
        }
      } else if (!overflow && length > sizeof(WaveformPrefix) - 1
                 && memcmp(line, WaveformPrefix, sizeof(WaveformPrefix) - 1) == 0) {
        constexpr size_t prefixLength = sizeof(WaveformPrefix) - 1;
        size_t decodedSize = 0;
        const int result = mbedtls_base64_decode(frame, sizeof(frame), &decodedSize,
          reinterpret_cast<const unsigned char*>(line + prefixLength), length - prefixLength);
        if (result == 0 && decodeFrame(frame, decodedSize, haveFullFrame, incoming)) {
          haveFullFrame = true;
          incoming.receivedAt = millis();
          incoming.sampledAt = lineStartedAt;
          xQueueOverwrite(snapshots, &incoming);
        }
      }
      overflow = false;
      length = 0;
    }
    const uint32_t now = millis();
    if ((!incoming.receivedAt || now - incoming.receivedAt >= StaleMs) && now - lastHello >= 2000) {
      port.println(CompanionHello);
      lastHello = now;
    }
    delay(2);
  }
}

void drawIdleLogo() {
  // Coordinate arrotondate dal logo.svg di NotoMixer (215 × 131).
  constexpr int triangles[][6] = {
    {114, 131, 68, 72, 91, 53}, {114, 131, 91, 53, 156, 131},
    {68, 72, 6, 0, 48, 0}, {68, 72, 48, 0, 91, 53},
    {86, 76, 41, 131, 0, 131}, {86, 76, 0, 131, 68, 53},
    {173, 131, 126, 72, 149, 53}, {173, 131, 149, 53, 215, 131},
    {126, 72, 65, 0, 107, 0}, {126, 72, 107, 0, 149, 53},
    {130, 52, 172, 0, 213, 0}, {130, 52, 213, 0, 148, 75},
  };
  const int x = (display.width() - 215) / 2;
  const int y = (display.height() - 131) / 2;
  display.startWrite();
  display.fillScreen(Background);
  for (const auto& t : triangles) {
    display.fillTriangle(x + t[0], y + t[1], x + t[2], y + t[3], x + t[4], y + t[5], TFT_WHITE);
  }
  display.endWrite();
}

void label(lgfx::LGFXBase& target, const char* value, int x, int y, uint32_t color,
           const lgfx::IFont* font = &lgfx::fonts::Font0,
           lgfx::textdatum_t datum = lgfx::textdatum_t::top_left) {
  target.setFont(font);
  target.setTextDatum(datum);
  target.setTextColor(color);
  target.drawString(value, x, y);
}

const lgfx::IFont* trackTitleFont(const char* title) {
  // LovyanGFX's DejaVu12 contains only printable ASCII.
  for (; *title; ++title) {
    if (static_cast<uint8_t>(*title) >= 0x80) return &lgfx::fonts::efontJA_16;
  }
  return &lgfx::fonts::DejaVu12;
}

void drawBrowser(const BrowserPage& page, bool reset) {
  constexpr int topHeight = 62;
  constexpr int footerHeight = 46;
  constexpr int headerHeight = 38;
  constexpr int titleX = 52;
  constexpr int counterWidth = 100;
  constexpr auto* LargeFont = &lgfx::fonts::DejaVu18;
  constexpr auto* RowFont = &lgfx::fonts::DejaVu12;
  constexpr uint32_t Selection = 0x383838;
  constexpr uint32_t Alternate = 0x141D29;
  const int width = display.width();
  const int footerY = display.height() - footerHeight;
  const int rowHeight = (footerY - topHeight) / BrowserRows;
  const int bpmX = width - 102;
  const int timeX = width - 20;
  static BrowserPage shown{};
  const bool listChanged = reset || page.start != shown.start || page.total != shown.total
    || page.count != shown.count
    || memcmp(page.rows, shown.rows, page.count * sizeof(BrowserRow)) != 0;
  const bool driveChanged = reset || strcmp(page.drive, shown.drive) != 0;
  const bool counterChanged = reset || page.start + page.count != shown.start + shown.count
    || page.total != shown.total;
  if (!listChanged && !driveChanged && page.selected == shown.selected) return;
  display.startWrite();
  if (reset) {
    display.fillScreen(Background);
    const int columnsY = (headerHeight + topHeight) / 2;
    label(display, "TITOLO", titleX, columnsY, Muted, RowFont, lgfx::textdatum_t::middle_left);
    label(display, "BPM", bpmX, columnsY, Muted, RowFont, lgfx::textdatum_t::middle_right);
    label(display, "TEMPO", timeX, columnsY, Muted, RowFont, lgfx::textdatum_t::middle_right);
    display.drawFastHLine(0, topHeight - 1, width, Border);
  }
  if (driveChanged) {
    char heading[64] = "AVAILABLE SONGS";
    if (page.drive[0]) {
      const bool driveLetter = page.drive[1] == ':' && page.drive[2] == '\0';
      snprintf(heading, sizeof(heading), "AVAILABLE SONGS (%s%s)", page.drive, driveLetter ? "\\" : "");
    }
    display.fillRect(0, 0, width - counterWidth, headerHeight, Background);
    display.setClipRect(0, 0, width - counterWidth, headerHeight);
    label(display, heading, 14, headerHeight / 2, Text, LargeFont, lgfx::textdatum_t::middle_left);
    display.clearClipRect();
  }
  if (counterChanged) {
    char count[24];
    snprintf(count, sizeof(count), "%lu/%lu", static_cast<unsigned long>(page.start + page.count),
             static_cast<unsigned long>(page.total));
    display.fillRect(width - counterWidth, 0, counterWidth, headerHeight, Background);
    display.setClipRect(width - counterWidth, 0, counterWidth, headerHeight);
    label(display, count, width - 16, headerHeight / 2, Text, LargeFont, lgfx::textdatum_t::middle_right);
    display.clearClipRect();
  }
  if (listChanged && page.count < BrowserRows) {
    const int y = topHeight + page.count * rowHeight;
    display.fillRect(0, y, width - 9, footerY - y, Background);
  }
  if (listChanged && !page.count) {
    label(display, "Nessun brano nella libreria", width / 2, (topHeight + footerY) / 2,
          Muted, RowFont, lgfx::textdatum_t::middle_center);
  }
  for (int i = 0; i < page.count; ++i) {
    const bool selected = i == page.selected;
    if (!listChanged && (page.selected == shown.selected || (!selected && i != shown.selected))) continue;
    const int y = topHeight + i * rowHeight;
    const int middle = y + rowHeight / 2;
    display.fillRect(0, y, width - 9, rowHeight, selected ? Selection : (i % 2 ? Alternate : Background));
    char number[12];
    snprintf(number, sizeof(number), "%lu", static_cast<unsigned long>(page.start + i + 1));
    display.setClipRect(7, y, titleX - 15, rowHeight);
    label(display, number, titleX - 9, middle, selected ? Text : Muted,
          RowFont, lgfx::textdatum_t::middle_right);
    display.setClipRect(titleX, y, bpmX - titleX - 60, rowHeight);
    label(display, page.rows[i].title, titleX, middle, Text,
          trackTitleFont(page.rows[i].title), lgfx::textdatum_t::middle_left);
    display.clearClipRect();
    char bpm[16] = "--";
    if (page.rows[i].bpm) snprintf(bpm, sizeof(bpm), "%.1f", page.rows[i].bpm / 10.0);
    char time[16] = "--:--";
    const unsigned seconds = page.rows[i].duration;
    if (seconds) snprintf(time, sizeof(time), "%u:%02u", seconds / 60, seconds % 60);
    label(display, bpm, bpmX, middle, selected ? Text : Muted,
          RowFont, lgfx::textdatum_t::middle_right);
    label(display, time, timeX, middle, selected ? Text : Muted,
          RowFont, lgfx::textdatum_t::middle_right);
  }
  if (reset || page.start != shown.start || page.total != shown.total) {
    const int top = topHeight + 2;
    const int height = footerY - topHeight - 4;
    display.fillRect(width - 6, top, 3, height, page.total > BrowserRows ? Border : Background);
    if (page.total > BrowserRows) {
      const int thumb = max(8, int(uint64_t(height) * BrowserRows / page.total));
      const int y = top + int(uint64_t(height - thumb) * page.start / (page.total - BrowserRows));
      display.fillRect(width - 6, y, 3, thumb, Muted);
    }
  }
  if (reset || bool(page.count) != bool(shown.count)) {
    display.fillRect(0, footerY, width, footerHeight, Panel);
    display.drawFastHLine(0, footerY, width, Border);
    label(display, "Load Deck 1", 16, footerY + footerHeight / 2, page.count ? Accent[0] : Muted,
          LargeFont, lgfx::textdatum_t::middle_left);
    label(display, "Load Deck 2", width - 16, footerY + footerHeight / 2, page.count ? Accent[1] : Muted,
          LargeFont, lgfx::textdatum_t::middle_right);
  }
  display.endWrite();
  shown = page;
}

void drawDeckHeader(int i, int y, const Deck& deck, bool pulse) {
  constexpr int titleStart = 37;
  constexpr int titleRightPadding = 10;
  const int center = y + DeckHeaderHeight / 2;
  const int textWidth = deckWidth - titleStart - HeaderRightWidth - titleRightPadding;
  display.startWrite();
  display.fillRect(0, y, deckWidth - HeaderRightWidth, DeckHeaderHeight,
                   pulse ? EndingPulse[i] : Panel);
  display.fillRect(0, y, 3, DeckHeaderHeight, Accent[i]);
  label(display, i == 0 ? "1" : "2", 12, center, pulse ? Text : Accent[i],
        &lgfx::fonts::DejaVu12, lgfx::textdatum_t::middle_left);
  display.drawFastVLine(titleStart - 7, y + 6, DeckHeaderHeight - 12, Border);
  display.setClipRect(titleStart, y, textWidth, DeckHeaderHeight);
  const char* title = deck.loaded ? deck.title : "Deck vuota";
  label(display, title, titleStart, center, Text, trackTitleFont(title), lgfx::textdatum_t::middle_left);
  display.clearClipRect();
  display.endWrite();
}

void drawBandColumn(lgfx::LGFX_Sprite& target, const Deck& deck, int x, int center,
                    int maxHeight, float begin, float end, uint32_t fallbackColor) {
  const int count = deck.peakCount;
  if (count == 0 || end <= 0.0f || begin >= 1.0f) return;
  const int first = max(0, int(begin * count));
  const int last = min(count, max(first + 1, int(ceilf(end * count))));
  int bass = 0;
  int mid = 0;
  int high = 0;
  for (int i = first; i < last; ++i) {
    const int sample = deck.peaks[i];
    if (deck.colored) {
      bass = max(bass, (sample >> 11) & 31);
      mid = max(mid, (sample >> 5) & 63);
      high = max(high, sample & 31);
    } else {
      bass = max(bass, sample);
    }
  }
  if (!deck.colored) {
    const int height = bass * maxHeight / 255;
    if (height) target.drawFastVLine(x, center - height, height * 2 + 1, fallbackColor);
    return;
  }
  // Use independent envelopes, leaving room for a visible outline around the brighter bands.
  const int lowHeight = bass * maxHeight / 31;
  const int midHeight = mid * maxHeight / 63;
  const int highHeight = high * maxHeight / 31;
  const int heights[] = {
    max(lowHeight, max(midHeight, highHeight)),
    midHeight * 4 / 5,
    highHeight * 7 / 10
  };
  int inner = -1;
  for (int band = 2; band >= 0; --band) {
    const int height = heights[band];
    if (!height || height <= inner) continue;
    if (inner < 0) {
      target.drawFastVLine(x, center - height, height * 2 + 1, BandColor[band]);
    } else {
      target.drawFastVLine(x, center - height, height - inner, BandColor[band]);
      target.drawFastVLine(x, center + inner + 1, height - inner, BandColor[band]);
    }
    inner = height;
  }
}

void drawLoopRegion(lgfx::LGFX_Sprite& target, const Deck& deck, float viewStart, float pixelsPerSecond) {
  if (!deck.looping || deck.loopStart < 0 || deck.loopEnd <= deck.loopStart
      || deck.loopEnd > deck.duration) return;
  const float startX = (deck.loopStart - viewStart) * pixelsPerSecond;
  const float endX = (deck.loopEnd - viewStart) * pixelsPerSecond;
  const int width = target.width();
  const int height = target.height();
  if (endX <= 0 || startX >= width) return;
  const int left = int(floorf(max(0.0f, startX)));
  const int right = int(ceilf(min(float(width), endX)));
  target.fillRect(left, 0, right - left, height, LoopFill);
  if (startX >= 0) target.drawFastVLine(left, 0, height, LoopEdge);
  if (endX < width) target.drawFastVLine(right - 1, 0, height, LoopEdge);
}

void drawWaveform(int i, int y, const Deck& deck, float position) {
  waveform.fillScreen(Background);
  const int center = chartHeight / 2;
  const int cursor = deckWidth / 2;
  if (deck.peakCount && deck.duration > 0.0f) {
    const float step = ViewSeconds / deckWidth;
    drawLoopRegion(waveform, deck, position - cursor * step, 1.0f / step);
    waveform.drawFastHLine(0, center, deckWidth, Border);
    for (int x = 0; x < deckWidth; ++x) {
      const float time = position + (x - cursor) * step;
      drawBandColumn(waveform, deck, x, center, center - 7,
                     time / deck.duration, (time + step) / deck.duration, Accent[i]);
    }
    if (deck.sourceBpm > 0 && fabsf(deck.beatOffset) < deck.duration + ViewSeconds) {
      const float beatLength = 60.0f / deck.sourceBpm;
      const float firstTime = max(0.0f, position - ViewSeconds / 2);
      int beat = max(0, int(ceilf((firstTime - deck.beatOffset) / beatLength)));
      const float lastTime = min(deck.duration, position + ViewSeconds / 2);
      for (float time = deck.beatOffset + beat * beatLength; time <= lastTime;
           time = deck.beatOffset + ++beat * beatLength) {
        const int x = lroundf(cursor + (time - position) / step);
        if (beat % 4 == 0) {
          waveform.drawFastVLine(x, 0, chartHeight, 0xB44862);
          char bar[12];
          snprintf(bar, sizeof(bar), "%d", beat / 4 + 1);
          waveform.fillRect(x + 2, 0, waveform.textWidth(bar) + 5, 10, Panel);
          label(waveform, bar, x + 4, 1, Text);
        } else {
          waveform.drawFastVLine(x, 0, 5, Muted);
          waveform.drawFastVLine(x, chartHeight - 5, 5, Muted);
        }
      }
    }

    for (int cue = 0; cue < 8; ++cue) {
      if (deck.cues[cue] < 0 || deck.cues[cue] > deck.duration) continue;
      const float cueX = cursor + (deck.cues[cue] - position) / step;
      if (cueX < 0 || cueX >= deckWidth) continue;
      const int x = int(cueX);
      waveform.drawFastVLine(x, 0, chartHeight, CueColor[cue]);
      char letter[] = {char('A' + cue), '\0'};
      label(waveform, letter, x + 3, chartHeight - 11, CueColor[cue]);
    }
    waveform.drawFastVLine(cursor, 0, chartHeight, Playhead);
    waveform.fillTriangle(cursor - 4, 0, cursor + 4, 0, cursor, 6, Playhead);
    waveform.fillTriangle(cursor - 4, chartHeight - 1, cursor + 4, chartHeight - 1,
                          cursor, chartHeight - 7, Playhead);
  }
  waveform.pushSprite(0, y + DeckHeaderHeight);
}

void drawWaveformLoading(int y, int center, int previousCenter, bool reset) {
  if (!reset && center == previousCenter) return;

  waveform.fillScreen(ShimmerBase);
  overview.fillScreen(ShimmerBase);
  for (int x = max(0, center - ShimmerRadius); x < min(deckWidth, center + ShimmerRadius); ++x) {
    const float t = 1.0f - float(abs(x - center)) / ShimmerRadius;
    const float light = t * t * (3.0f - 2.0f * t);
    uint32_t color = 0;
    for (int shift = 0; shift <= 16; shift += 8) {
      const int base = (ShimmerBase >> shift) & 255;
      const int highlight = (ShimmerHighlight >> shift) & 255;
      color |= uint32_t(base + lroundf((highlight - base) * light)) << shift;
    }
    waveform.drawFastVLine(x, 0, chartHeight, color);
    overview.drawFastVLine(x, 0, OverviewHeight, color);
  }
  label(waveform, "Waveform in attesa", deckWidth / 2, chartHeight / 2, Muted,
        &lgfx::fonts::Font0, lgfx::textdatum_t::middle_center);

  const int top = y + DeckHeaderHeight;
  const int height = chartHeight + OverviewHeight;
  const auto pushRegion = [&](int left, int right) {
    left = max(0, left);
    right = min(deckWidth, right);
    if (right <= left) return;
    display.setClipRect(left, top, right - left, height);
    waveform.pushSprite(0, top);
    overview.pushSprite(0, top + chartHeight);
  };

  display.startWrite();
  if (reset) {
    pushRegion(0, deckWidth);
  } else if (center < previousCenter) {
    pushRegion(previousCenter - ShimmerRadius, deckWidth);
    pushRegion(0, center + ShimmerRadius);
  } else {
    pushRegion(previousCenter - ShimmerRadius, center + ShimmerRadius);
  }
  display.clearClipRect();
  display.endWrite();
}

void drawOverview(int i, int y, const Deck& deck, int progress) {
  overview.fillScreen(Background);
  if (progress >= 0) {
    drawLoopRegion(overview, deck, 0.0f, deckWidth / deck.duration);
    for (int x = 0; x < deckWidth; ++x) {
      drawBandColumn(overview, deck, x, OverviewHeight / 2 + 1, (OverviewHeight - 3) / 2,
                     float(x) / deckWidth, float(x + 1) / deckWidth, Accent[i]);
    }
    for (int cue = 0; cue < 8; ++cue) {
      if (deck.cues[cue] < 0 || deck.cues[cue] > deck.duration) continue;
      const int x = min(deckWidth - 1, int(deck.cues[cue] * deckWidth / deck.duration));
      overview.drawFastVLine(x, 1, 6, CueColor[cue]);
    }
    overview.drawFastVLine(progress, 1, OverviewHeight - 1, Playhead);
    overview.drawFastHLine(0, 0, deckWidth, Border);
  }
  overview.pushSprite(0, y + DeckHeaderHeight + chartHeight);
}

uint32_t transportIconColor(uint32_t elapsed, bool endSyncActive) {
  constexpr float fullTurn = 6.2831853f;
  const float phase = float(elapsed % PlayFadePeriodMs) / PlayFadePeriodMs;
  const float minimumOpacity = endSyncActive ? 0.0f : 0.18f;
  const float opacity = minimumOpacity + (1.0f - minimumOpacity) * 0.5f * (1.0f - cosf(phase * fullTurn));
  const auto blendWhite = [opacity](uint8_t base) {
    return uint8_t(lroundf(base + (255 - base) * opacity));
  };
  return display.color888(blendWhite((Panel >> 16) & 255),
                          blendWhite((Panel >> 8) & 255),
                          blendWhite(Panel & 255));
}

void drawTransportIcon(const Deck& deck, uint32_t iconColor, bool showEndSync) {
  constexpr int center = DeckHeaderHeight / 2;
  headerRight.fillRect(0, 0, TransportIconWidth, DeckHeaderHeight, Panel);
  if (showEndSync) {
    label(headerRight, "ES", 15, center, iconColor,
          &lgfx::fonts::DejaVu12, lgfx::textdatum_t::middle_center);
  } else if (deck.playing) {
    constexpr int top = (DeckHeaderHeight - 12) / 2;
    headerRight.fillTriangle(10, top, 10, top + 11, 20, center - 1, iconColor);
    headerRight.fillTriangle(10, top, 10, top + 11, 20, center, iconColor);
  } else if (deck.loaded) {
    headerRight.fillRect(10, center - 5, 3, 10, TFT_WHITE);
    headerRight.fillRect(16, center - 5, 3, 10, TFT_WHITE);
  }
}

void drawTransport(int i, int y, const Deck& deck, unsigned remaining, uint32_t iconColor, bool showEndSync) {
  constexpr int center = DeckHeaderHeight / 2;
  headerRight.fillScreen(Panel);
  drawTransportIcon(deck, iconColor, showEndSync);
  char time[16];
  snprintf(time, sizeof(time), "-%02u:%02u", remaining / 60, remaining % 60);
  label(headerRight, deck.duration > 0 ? time : "--:--", 91, center, Text,
        &lgfx::fonts::DejaVu12, lgfx::textdatum_t::middle_right);
  headerRight.drawFastVLine(99, 6, DeckHeaderHeight - 12, Border);
  char bpm[20];
  snprintf(bpm, sizeof(bpm), deck.loaded && deck.bpm > 0 ? "%.1f BPM" : "-- BPM", deck.bpm);
  label(headerRight, bpm, HeaderRightWidth - 9, center, Accent[i],
        &lgfx::fonts::DejaVu12, lgfx::textdatum_t::middle_right);
  headerRight.pushSprite(deckWidth - HeaderRightWidth, y);
}

float displayedPosition(const Deck& deck, uint32_t elapsed) {
  const float position = deck.position + deck.rate * min(elapsed, uint32_t(1800)) / 1000.0f;
  return constrain(position, 0.0f, deck.duration);
}

bool isBeatPulse(const Deck& deck, float position) {
  const float bpm = max(20.0f, deck.sourceBpm > 0 ? deck.sourceBpm : 120.0f);
  const float beat = (position - deck.beatOffset) * bpm / 60.0f;
  return beat - floorf(beat) < 0.30f;
}

void renderLive(uint32_t now, bool newSnapshot, bool redraw) {
  static Snapshot drawn{};
  static float positions[] = {-1.0f, -1.0f};
  static int overviewPositions[] = {-1, -1};
  static bool pulseShown[2]{};
  static uint32_t transportAnimationStartedAt[2]{};
  static uint32_t iconColorShown[2]{};
  static bool endSyncSymbolShown[2]{};
  static bool wasLoading[2]{};
  static uint32_t loadingStartedAt[2]{};
  static int loadingCenter[2]{};
  if (redraw) {
    display.fillScreen(Background);
  }
  for (int i = 0; i < 2; ++i) {
    const Deck& deck = current.decks[i];
    const int y = i * deckHeight;
    const uint32_t elapsed = now - current.sampledAt;
    const float position = displayedPosition(deck, elapsed);
    const Deck& prior = drawn.decks[i];
    const bool titleChanged = deck.loaded != prior.loaded || strcmp(deck.title, prior.title) != 0;
    const bool peaksChanged = newSnapshot && (deck.peakCount != prior.peakCount
      || memcmp(deck.peaks, prior.peaks, deck.peakCount * sizeof(deck.peaks[0])) != 0);
    const bool durationChanged = deck.duration != prior.duration;
    const bool markersChanged = newSnapshot && (deck.looping != prior.looping
      || deck.loopStart != prior.loopStart || deck.loopEnd != prior.loopEnd
      || memcmp(deck.cues, prior.cues, sizeof(deck.cues)) != 0);
    const bool gridChanged = deck.sourceBpm != prior.sourceBpm || deck.beatOffset != prior.beatOffset;
    const Deck& outgoing = current.decks[1 - i];
    const bool pulse = deck.endSyncCountdown && !deck.playing && outgoing.playing
      ? isBeatPulse(outgoing, displayedPosition(outgoing, elapsed))
      : deck.endingWarning && !deck.looping && isBeatPulse(deck, position);
    if (redraw || titleChanged || pulse != pulseShown[i]) {
      drawDeckHeader(i, y, deck, pulse);
      pulseShown[i] = pulse;
    }
    static unsigned remainingShown[2]{};
    const unsigned remaining = unsigned(ceilf(min(deck.duration - position, 359999.0f)));
    if (deck.playing && (redraw || !prior.playing)) {
      transportAnimationStartedAt[i] = now;
    } else if (deck.endSyncActive && !prior.endSyncActive) {
      // Keep the current Play fade phase and start the alternation with Play.
      transportAnimationStartedAt[i] = now - (now - transportAnimationStartedAt[i]) % PlayFadePeriodMs;
    }
    const uint32_t animationElapsed = now - transportAnimationStartedAt[i];
    const bool showEndSync = deck.endSyncActive && (animationElapsed / PlayFadePeriodMs) % 2 == 1;
    const uint32_t iconColor = deck.playing ? transportIconColor(animationElapsed, deck.endSyncActive) : 0xFFFFFF;
    if (redraw || durationChanged || deck.loaded != prior.loaded || deck.playing != prior.playing
        || remaining != remainingShown[i] || lroundf(deck.bpm * 10) != lroundf(prior.bpm * 10)) {
      drawTransport(i, y, deck, remaining, iconColor, showEndSync);
      remainingShown[i] = remaining;
    } else if (deck.playing && (iconColor != iconColorShown[i] || showEndSync != endSyncSymbolShown[i])) {
      const int x = deckWidth - HeaderRightWidth;
      drawTransportIcon(deck, iconColor, showEndSync);
      display.setClipRect(x, y, TransportIconWidth, DeckHeaderHeight);
      headerRight.pushSprite(x, y);
      display.clearClipRect();
    }
    iconColorShown[i] = iconColor;
    endSyncSymbolShown[i] = showEndSync;
    const bool loading = deck.loaded && (!deck.peakCount || deck.duration <= 0.0f);
    const bool loadingChanged = loading != wasLoading[i];
    if (loading) {
      const bool reset = redraw || loadingChanged || titleChanged;
      if (reset) loadingStartedAt[i] = now;
      const uint32_t phase = (now - loadingStartedAt[i]) % ShimmerPeriodMs;
      const int center = int(phase * (deckWidth + 2 * ShimmerRadius) / ShimmerPeriodMs) - ShimmerRadius;
      drawWaveformLoading(y, center, loadingCenter[i], reset);
      loadingCenter[i] = center;
    } else if (redraw || loadingChanged || peaksChanged || durationChanged || markersChanged || gridChanged
        || deck.colored != prior.colored || deck.loaded != prior.loaded
        || (deck.peakCount && fabsf(position - positions[i]) >= ViewSeconds / deckWidth)) {
      drawWaveform(i, y, deck, position);
      positions[i] = position;
    }
    const int progress = deck.peakCount && deck.duration > 0.0f
      ? min(deckWidth - 1, int(position * deckWidth / deck.duration)) : -1;
    if (!loading && (redraw || loadingChanged || peaksChanged || durationChanged
        || markersChanged || progress != overviewPositions[i])) {
      drawOverview(i, y, deck, progress);
      overviewPositions[i] = progress;
    }
    wasLoading[i] = loading;
    if (redraw || newSnapshot) drawn.decks[i] = deck;
  }
}

}  // namespace

void setup() {
  if (CompanionUseNativeUsb) {
    Serial.setRxBufferSize(8192);
    Serial.begin(CompanionBaud);
  } else {
    Serial0.setRxBufferSize(8192);
    Serial0.begin(CompanionBaud);
  }
  display.beginDisplay();
  drawIdleLogo();

  deckWidth = display.width();
  deckHeight = display.height() / 2;
  chartHeight = deckHeight - DeckHeaderHeight - OverviewHeight;
  waveform.setColorDepth(16);
  waveform.setPsram(psramFound());
  headerRight.setColorDepth(16);
  overview.setColorDepth(16);
  if (!waveform.createSprite(deckWidth, chartHeight)
      || !headerRight.createSprite(HeaderRightWidth, DeckHeaderHeight)
      || !overview.createSprite(deckWidth, OverviewHeight)) {
    label(display, "Errore memoria display", 12, 12, Text);
    return;
  }
  snapshots = xQueueCreate(1, sizeof(Snapshot));
  browserPages = xQueueCreate(1, sizeof(BrowserPage));
  if (!snapshots || !browserPages
      || xTaskCreate(serialTask, "notomixer-serial", 6144, nullptr, 1, nullptr) != pdPASS) {
    if (snapshots) vQueueDelete(snapshots);
    if (browserPages) vQueueDelete(browserPages);
    snapshots = nullptr;
    browserPages = nullptr;
    label(display, "Errore avvio seriale", 12, 12, Text);
  }
}

void loop() {
  static bool wasLive = false;
  static bool wasBrowsing = false;
  const bool newSnapshot = snapshots && xQueueReceive(snapshots, &current, 0) == pdTRUE;
  const bool newPage = browserPages && xQueueReceive(browserPages, &browser, 0) == pdTRUE;
  const uint32_t now = millis();
  if (snapshots) {
    const bool live = current.receivedAt && now - current.receivedAt < StaleMs;
    const bool browsing = live && browser.open;
    if (browsing) {
      if (!wasBrowsing || newPage) drawBrowser(browser, !wasBrowsing);
    } else if (live) {
      renderLive(now, newSnapshot, !wasLive || wasBrowsing);
    } else if (wasLive) {
      drawIdleLogo();
    }
    if (!live && wasLive) browser.open = false;
    wasLive = live;
    wasBrowsing = browsing;
  }
  constexpr uint32_t interval = uint32_t(1000 / DrawHz);
  const uint32_t elapsed = millis() - now;
  delay(elapsed < interval ? interval - elapsed : 1);
}
