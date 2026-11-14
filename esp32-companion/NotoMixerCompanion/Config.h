#pragma once

#include <Arduino.h>
#include <driver/spi_master.h>

// false per la porta UART del bridge CH343, true per la USB nativa.
constexpr bool CompanionUseNativeUsb = false;
constexpr uint32_t CompanionBaud = 115200;

// ILI9488 SPI, preset dello sketch funzionante sul modulo.
constexpr spi_host_device_t DisplaySpiHost = SPI2_HOST;
constexpr uint8_t DisplaySpiMode = 0;
constexpr uint32_t DisplayWriteHz = 75000000;
constexpr uint32_t DisplayReadHz = 10000000;
constexpr bool DisplaySpi3Wire = false;
constexpr bool DisplaySpiUseLock = true;
constexpr auto DisplayDmaChannel = SPI_DMA_CH_AUTO;
constexpr int DisplayCsPin = 10;
constexpr int DisplayResetPin = 9;
constexpr int DisplayDcPin = 8;
constexpr int DisplayMosiPin = 11;
constexpr int DisplayClockPin = 12;
constexpr int DisplayMisoPin = 13;
constexpr int DisplayBusyPin = -1;
constexpr uint16_t DisplayWidth = 320;
constexpr uint16_t DisplayHeight = 480;
constexpr uint16_t DisplayOffsetX = 0;
constexpr uint16_t DisplayOffsetY = 0;
constexpr uint8_t DisplayRotation = 1;
constexpr bool DisplayReadable = false;
constexpr bool DisplayInverted = false;
constexpr bool DisplayBgr = false;
constexpr bool Display16BitLength = false;
constexpr bool DisplayBusShared = false;
constexpr int BacklightPin = 7;
constexpr bool BacklightActiveHigh = true;
constexpr uint32_t DisplayPowerOnDelayMs = 300;
constexpr bool DisplayColorTest = false;
constexpr uint32_t DisplayColorTestMs = 500;
