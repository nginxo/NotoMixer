#pragma once

#include <Arduino.h>

constexpr int BrowserRows = 8;

struct BrowserRow {
  char title[80];
  uint16_t bpm;
  uint16_t duration;
};

struct BrowserPage {
  bool open;
  uint8_t count;
  uint8_t selected;
  uint32_t total;
  uint32_t start;
  char drive[32];
  BrowserRow rows[BrowserRows];
};

inline uint32_t readBrowserIndex(const uint8_t* bytes) {
  return uint32_t(bytes[0]) | (uint32_t(bytes[1]) << 8)
    | (uint32_t(bytes[2]) << 16) | (uint32_t(bytes[3]) << 24);
}

inline bool decodeBrowserPage(const uint8_t* bytes, size_t size, BrowserPage& page) {
  if (size < 12 || bytes[0] > 1 || bytes[1] > BrowserRows) return false;
  const size_t rowsEnd = 12 + size_t(bytes[1]) * 84;
  if (size != rowsEnd + sizeof(page.drive)) return false;
  const uint32_t total = readBrowserIndex(bytes + 4);
  const uint32_t start = readBrowserIndex(bytes + 8);
  if (start > total || bytes[1] > total - start
      || (bytes[1] && bytes[2] >= bytes[1])) return false;
  page.open = bytes[0] != 0;
  page.count = bytes[1];
  page.selected = bytes[2];
  page.total = total;
  page.start = start;
  memcpy(page.drive, bytes + rowsEnd, sizeof(page.drive) - 1);
  page.drive[sizeof(page.drive) - 1] = '\0';
  for (int i = 0; i < page.count; ++i) {
    const uint8_t* record = bytes + 12 + i * 84;
    memcpy(page.rows[i].title, record, 79);
    page.rows[i].title[79] = '\0';
    page.rows[i].bpm = record[80] | (uint16_t(record[81]) << 8);
    page.rows[i].duration = record[82] | (uint16_t(record[83]) << 8);
  }
  return true;
}
