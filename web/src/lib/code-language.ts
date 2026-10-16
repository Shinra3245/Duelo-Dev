import type { Language } from '@duelodev/shared';

export const LANGUAGE_FILES: Record<Language, string> = {
  python: 'solution.py',
  cpp: 'main.cpp',
  java: 'Main.java',
};

export const LANGUAGE_TEMPLATES: Record<Language, string> = {
  python: '',
  cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n  // Lee la entrada con cin y escribe la respuesta con cout.\n  return 0;\n}\n',
  java: 'import java.util.Scanner;\n\npublic class Main {\n  public static void main(String[] args) {\n    Scanner input = new Scanner(System.in);\n    // Lee la entrada y escribe la respuesta con System.out.println.\n  }\n}\n',
};

export function editorLabel(language: Language): string {
  return `Editor de solución ${language === 'python' ? 'Python' : language === 'cpp' ? 'C++' : 'Java'}`;
}
