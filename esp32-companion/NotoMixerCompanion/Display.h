#pragma once

#include <LovyanGFX.hpp>
#include "Config.h"

class CompanionDisplay : public lgfx::LGFX_Device {
  lgfx::Bus_SPI bus;
  lgfx::Panel_ILI9488 panel;

public:
  CompanionDisplay() {
    auto spi = bus.config();
    spi.spi_host = DisplaySpiHost;
    spi.spi_mode = DisplaySpiMode;
    spi.freq_write = DisplayWriteHz;
    spi.freq_read = DisplayReadHz;
    spi.spi_3wire = DisplaySpi3Wire;
    spi.use_lock = DisplaySpiUseLock;
    spi.dma_channel = DisplayDmaChannel;
    spi.pin_sclk = DisplayClockPin;
    spi.pin_mosi = DisplayMosiPin;
    spi.pin_miso = DisplayMisoPin;
    spi.pin_dc = DisplayDcPin;
    bus.config(spi);
    panel.setBus(&bus);

    auto lcd = panel.config();
    lcd.pin_cs = DisplayCsPin;
    lcd.pin_rst = DisplayResetPin;
    lcd.pin_busy = DisplayBusyPin;
    lcd.memory_width = lcd.panel_width = DisplayWidth;
    lcd.memory_height = lcd.panel_height = DisplayHeight;
    lcd.offset_x = DisplayOffsetX;
    lcd.offset_y = DisplayOffsetY;
    lcd.readable = DisplayReadable;
    lcd.invert = DisplayInverted;
    lcd.rgb_order = DisplayBgr;
    lcd.dlen_16bit = Display16BitLength;
    lcd.bus_shared = DisplayBusShared;
    panel.config(lcd);
    setPanel(&panel);
  }

  void beginDisplay() {
    delay(DisplayPowerOnDelayMs);
    if (BacklightPin >= 0) {
      pinMode(BacklightPin, OUTPUT);
      digitalWrite(BacklightPin, BacklightActiveHigh ? LOW : HIGH);
    }
    init();
    setRotation(DisplayRotation);
    if (BacklightPin >= 0) {
      digitalWrite(BacklightPin, BacklightActiveHigh ? HIGH : LOW);
    }
    if (DisplayColorTest) {
      for (const auto color : {TFT_RED, TFT_GREEN, TFT_BLUE}) {
        fillScreen(color);
        delay(DisplayColorTestMs);
      }
    }
  }
};
