import React from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {EditorScreen} from './src/EditorScreen';

/// App entry: the single editor screen (native toolbar + webview), at parity with the Flutter and
/// iOS reference apps.
function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <EditorScreen />
    </SafeAreaProvider>
  );
}

export default App;
