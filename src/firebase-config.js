// Firebase 연결 설정 (claude.ai 밖에서 돌아가는 사이트용)
// Firebase 콘솔 → 프로젝트 설정 → 일반 → 내 앱 → "SDK 설정 및 구성"의 firebaseConfig 값을 그대로 붙여넣습니다.
// 비어 있으면 앱은 이 브라우저(localStorage)에만 저장하는 모드로 열립니다.
// 로그인은 구글 계정(v347). 들어올 수 있는 사람은 Firestore의 members 모음에 등록된 구글 이메일뿐입니다(앱 기준정보 → 사용자 관리).
export const firebaseConfig = {
  apiKey: 'AIzaSyCl1Tk60POwaC6jghUU0zoMjsriU1KWJH8',
  authDomain: 'yozm-production.firebaseapp.com',
  projectId: 'yozm-production',
  storageBucket: 'yozm-production.firebasestorage.app',
  messagingSenderId: '922889848649',
  appId: '1:922889848649:web:610716d5013e8514b53c98',
};
