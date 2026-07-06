#define PIN_SLIDER 17
#define PIN_VOCALS1 5
#define PIN_INSTRUMENTAL1 6
#define PIN_MAIN1 7
#define PIN_SPEED1 11
#define PIN_ECHO1 12

// New optional controls (set to 1 to enable analog reading)
#define ENABLE_ADDITIONAL_CONTROLS 0

#if ENABLE_ADDITIONAL_CONTROLS
#define PIN_FILTER1 32
#define PIN_PAN1 33
#define PIN_REVERB1 34
#define PIN_ECHOTIME1 35

int lastSentFilter = -999;
int lastSentPan = -999;
int lastSentReverb = -999;
int lastSentEchoTime = -999;
#endif

#define BUTTON_STOP_PIN 18
#define BUTTON_PLAY_PIN 16
#define SWITCH_ENABLE_PIN 15

int lastSentSlider = -999;
int lastSentVocals = -999;
int lastSentInstrumental = -999;
int lastSentMain = -999;
int lastSentSpeed = -999;
int lastSentEcho = -999;
bool sliderEnabled = true; // Enabled by default at startup
String inputBuffer = ""; // Buffer for non-blocking serial commands

// States and debounce for STOP button
bool lastStopButtonState = HIGH;
unsigned long lastStopDebounceTime = 0;

// States and debounce for PLAY/PAUSE button
bool lastPlayButtonState = HIGH;
unsigned long lastPlayDebounceTime = 0;

// States and debounce for Slider Toggle button (PIN 15)
bool lastEnableButtonState = HIGH;
unsigned long lastEnableDebounceTime = 0;

const unsigned long debounceDelay = 50;

void setup() {
  Serial.begin(115200);
  delay(1500); // allow ADC to stabilize
  
  // Configure buttons with internal pull-up
  pinMode(BUTTON_STOP_PIN, INPUT_PULLUP);
  pinMode(BUTTON_PLAY_PIN, INPUT_PULLUP);
  pinMode(SWITCH_ENABLE_PIN, INPUT_PULLUP);
  
  // Send initial potentiometer values at startup/connection
  sendAllCurrentValues();
}

// Generic smoothing read function accepting the pin as a parameter
int readSmooth(int pin) {
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return sum / 10;
}

void sendAllCurrentValues() {
  // Read all analog inputs
  int rawSlider = readSmooth(PIN_SLIDER);
  int rawVocals = readSmooth(PIN_VOCALS1);
  int rawInstrumental = readSmooth(PIN_INSTRUMENTAL1);
  int rawMain = readSmooth(PIN_MAIN1);
  int rawSpeed = readSmooth(PIN_SPEED1);
  int rawEcho = readSmooth(PIN_ECHO1);
  
  // Clean boundaries
  if (rawSlider < 50) rawSlider = 0; if (rawSlider > 4000) rawSlider = 4095;
  if (rawVocals < 50) rawVocals = 0; if (rawVocals > 4000) rawVocals = 4095;
  if (rawInstrumental < 50) rawInstrumental = 0; if (rawInstrumental > 4000) rawInstrumental = 4095;
  if (rawMain < 50) rawMain = 0; if (rawMain > 4000) rawMain = 4095;
  if (rawSpeed < 50) rawSpeed = 0; if (rawSpeed > 4000) rawSpeed = 4095;
  if (rawEcho < 50) rawEcho = 0; if (rawEcho > 4000) rawEcho = 4095;

  int mappedSlider = map(rawSlider, 0, 4095, 0, 2040);
  int mappedVocals = map(rawVocals, 0, 4095, 0, 1023);
  int mappedInstrumental = map(rawInstrumental, 0, 4095, 0, 1023);
  int mappedMain = map(rawMain, 0, 4095, 0, 1023);
  int mappedSpeed = map(rawSpeed, 0, 4095, 0, 1023);
  int mappedEcho = map(rawEcho, 0, 4095, 0, 1023);

  // Send them all!
  if (sliderEnabled) {
    Serial.println("T1:POS:" + String(mappedSlider));
  }
  Serial.println("T1:VOC:" + String(mappedVocals));
  Serial.println("T1:INST:" + String(mappedInstrumental));
  Serial.println("T1:VOL:" + String(mappedMain));
  Serial.println("T1:SPEED:" + String(mappedSpeed));
  Serial.println("T1:ECHO:" + String(mappedEcho));
  
#if ENABLE_ADDITIONAL_CONTROLS
  int rawFilter = readSmooth(PIN_FILTER1);
  int rawPan = readSmooth(PIN_PAN1);
  int rawReverb = readSmooth(PIN_REVERB1);
  int rawEchoTime = readSmooth(PIN_ECHOTIME1);

  if (rawFilter < 50) rawFilter = 0; if (rawFilter > 4000) rawFilter = 4095;
  if (rawPan < 50) rawPan = 0; if (rawPan > 4000) rawPan = 4095;
  if (rawReverb < 50) rawReverb = 0; if (rawReverb > 4000) rawReverb = 4095;
  if (rawEchoTime < 50) rawEchoTime = 0; if (rawEchoTime > 4000) rawEchoTime = 4095;

  int mappedFilter = map(rawFilter, 0, 4095, 0, 1023);
  int mappedPan = map(rawPan, 0, 4095, 0, 1023);
  int mappedReverb = map(rawReverb, 0, 4095, 0, 1023);
  int mappedEchoTime = map(rawEchoTime, 0, 4095, 0, 1023);

  Serial.println("T1:FILT:" + String(mappedFilter));
  Serial.println("T1:PAN:" + String(mappedPan));
  Serial.println("T1:REV:" + String(mappedReverb));
  Serial.println("T1:ECHOTIME:" + String(mappedEchoTime));

  lastSentFilter = mappedFilter;
  lastSentPan = mappedPan;
  lastSentReverb = mappedReverb;
  lastSentEchoTime = mappedEchoTime;
#endif
  
  // Sync lastSent variables to prevent immediate re-sends
  lastSentSlider = mappedSlider;
  lastSentVocals = mappedVocals;
  lastSentInstrumental = mappedInstrumental;
  lastSentMain = mappedMain;
  lastSentSpeed = mappedSpeed;
  lastSentEcho = mappedEcho;
}

void checkIncomingSerial() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      inputBuffer.trim();
      if (inputBuffer.indexOf("CONN:1") >= 0) {
        sendAllCurrentValues();
      }
      inputBuffer = ""; // Clear the buffer for the next command
    } else {
      inputBuffer += c;
      // Prevent RAM saturation if continuous noise arrives without newline
      if (inputBuffer.length() > 64) {
        inputBuffer = "";
      }
    }
  }
}

void loop() {
  checkIncomingSerial();
  
  // --- Lettura Potenziometro Slider (Posizione) ---
  int rawSlider = readSmooth(PIN_SLIDER);
  if (rawSlider < 50) rawSlider = 0;
  if (rawSlider > 4000) rawSlider = 4095;
  
  int mappedSlider = map(rawSlider, 0, 4095, 0, 2040);

  // Send position only if slider is enabled AND if it differs by more than 5 from last send
  if (sliderEnabled && (abs(mappedSlider - lastSentSlider) > 5)) {
    lastSentSlider = mappedSlider;
    Serial.println("T1:POS:" + String(mappedSlider));
  }

  // --- Lettura Potenziometro Vocals ---
  int rawVocals = readSmooth(PIN_VOCALS1);
  if (rawVocals < 50) rawVocals = 0;
  if (rawVocals > 4000) rawVocals = 4095;
  
  int mappedVocals = map(rawVocals, 0, 4095, 0, 1023); // Knobs volume goes from 0 to 1023

  // Send Vocals volume only if it differs by more than 3 from last send
  if (abs(mappedVocals - lastSentVocals) > 3) {
    lastSentVocals = mappedVocals;
    Serial.println("T1:VOC:" + String(mappedVocals));
  }

  // --- Lettura Potenziometro Instrumental ---
  int rawInstrumental = readSmooth(PIN_INSTRUMENTAL1);
  if (rawInstrumental < 50) rawInstrumental = 0;
  if (rawInstrumental > 4000) rawInstrumental = 4095;
  
  int mappedInstrumental = map(rawInstrumental, 0, 4095, 0, 1023);

  // Send Instrumental volume only if it differs by more than 3 from last send
  if (abs(mappedInstrumental - lastSentInstrumental) > 3) {
    lastSentInstrumental = mappedInstrumental;
    Serial.println("T1:INST:" + String(mappedInstrumental));
  }

  // --- Read Main Potentiometer (Track Volume) ---
  int rawMain = readSmooth(PIN_MAIN1);
  if (rawMain < 50) rawMain = 0;
  if (rawMain > 4000) rawMain = 4095;
  
  int mappedMain = map(rawMain, 0, 4095, 0, 1023);

  // Send Main volume (T1:VOL) only if it differs by more than 3 from last send
  if (abs(mappedMain - lastSentMain) > 3) {
    lastSentMain = mappedMain;
    Serial.println("T1:VOL:" + String(mappedMain));
  }

  // --- Read Speed Potentiometer ---
  int rawSpeed = readSmooth(PIN_SPEED1);
  if (rawSpeed < 50) rawSpeed = 0;
  if (rawSpeed > 4000) rawSpeed = 4095;
  
  int mappedSpeed = map(rawSpeed, 0, 4095, 0, 1023);

  // Send speed (T1:SPEED) only if it differs by more than 3 from last send
  if (abs(mappedSpeed - lastSentSpeed) > 3) {
    lastSentSpeed = mappedSpeed;
    Serial.println("T1:SPEED:" + String(mappedSpeed));
  }

  // --- Read Echo Potentiometer ---
  int rawEcho = readSmooth(PIN_ECHO1);
  if (rawEcho < 50) rawEcho = 0;
  if (rawEcho > 4000) rawEcho = 4095;
  
  int mappedEcho = map(rawEcho, 0, 4095, 0, 1023);

  // Send echo (T1:ECHO) only if it differs by more than 3 from last send
  if (abs(mappedEcho - lastSentEcho) > 3) {
    lastSentEcho = mappedEcho;
    Serial.println("T1:ECHO:" + String(mappedEcho));
  }

#if ENABLE_ADDITIONAL_CONTROLS
  // --- Read Filter Potentiometer ---
  int rawFilter = readSmooth(PIN_FILTER1);
  if (rawFilter < 50) rawFilter = 0;
  if (rawFilter > 4000) rawFilter = 4095;
  int mappedFilter = map(rawFilter, 0, 4095, 0, 1023);
  if (abs(mappedFilter - lastSentFilter) > 3) {
    lastSentFilter = mappedFilter;
    Serial.println("T1:FILT:" + String(mappedFilter));
  }

  // --- Read Pan Potentiometer ---
  int rawPan = readSmooth(PIN_PAN1);
  if (rawPan < 50) rawPan = 0;
  if (rawPan > 4000) rawPan = 4095;
  int mappedPan = map(rawPan, 0, 4095, 0, 1023);
  if (abs(mappedPan - lastSentPan) > 3) {
    lastSentPan = mappedPan;
    Serial.println("T1:PAN:" + String(mappedPan));
  }

  // --- Read Reverb Potentiometer ---
  int rawReverb = readSmooth(PIN_REVERB1);
  if (rawReverb < 50) rawReverb = 0;
  if (rawReverb > 4000) rawReverb = 4095;
  int mappedReverb = map(rawReverb, 0, 4095, 0, 1023);
  if (abs(mappedReverb - lastSentReverb) > 3) {
    lastSentReverb = mappedReverb;
    Serial.println("T1:REV:" + String(mappedReverb));
  }

  // --- Read Echo Time Potentiometer ---
  int rawEchoTime = readSmooth(PIN_ECHOTIME1);
  if (rawEchoTime < 50) rawEchoTime = 0;
  if (rawEchoTime > 4000) rawEchoTime = 4095;
  int mappedEchoTime = map(rawEchoTime, 0, 4095, 0, 1023);
  if (abs(mappedEchoTime - lastSentEchoTime) > 3) {
    lastSentEchoTime = mappedEchoTime;
    Serial.println("T1:ECHOTIME:" + String(mappedEchoTime));
  }
#endif

  // --- Read STOP Button (Debounce) ---
  bool currentStopButtonState = digitalRead(BUTTON_STOP_PIN);
  if (currentStopButtonState != lastStopButtonState) {
    if ((millis() - lastStopDebounceTime) > debounceDelay) {
      lastStopButtonState = currentStopButtonState;
      if (currentStopButtonState == LOW) { // Button pressed (pulls to GND)
        Serial.println("T1:STOP:1");
      }
    }
    lastStopDebounceTime = millis();
  }

  // --- Read PLAY/PAUSE Button (Debounce) ---
  bool currentPlayButtonState = digitalRead(BUTTON_PLAY_PIN);
  if (currentPlayButtonState != lastPlayButtonState) {
    if ((millis() - lastPlayDebounceTime) > debounceDelay) {
      lastPlayButtonState = currentPlayButtonState;
      if (currentPlayButtonState == LOW) { // Button pressed (pulls to GND)
        Serial.println("T1:PLAY:1");
      }
    }
    lastPlayDebounceTime = millis();
  }

  // --- Read Slider Enable Toggle Button (PIN 15 with Debounce) ---
  bool currentEnableButtonState = digitalRead(SWITCH_ENABLE_PIN);
  if (currentEnableButtonState != lastEnableButtonState) {
    if ((millis() - lastEnableDebounceTime) > debounceDelay) {
      lastEnableButtonState = currentEnableButtonState;
      if (currentEnableButtonState == LOW) { // Button pressed
        sliderEnabled = !sliderEnabled;
        if (sliderEnabled) {
          Serial.println("INFO: Slider enabled");
        } else {
          Serial.println("INFO: Slider disabled");
        }
      }
    }
    lastEnableDebounceTime = millis();
  }

  delay(30); // 30ms delay for stability
}