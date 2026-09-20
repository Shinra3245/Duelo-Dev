import type { ProblemCategory } from '@duelodev/shared';
import type { SeedProblem, SeedTestCase } from './types.js';

type CaseIO = readonly [input: string, expectedOutput: string];

function makeTestCases(examples: readonly CaseIO[], hidden: readonly CaseIO[]): SeedTestCase[] {
  if (examples.length !== 2 || hidden.length !== 10) {
    throw new Error('Cada reto activo requiere exactamente 2 ejemplos y 10 casos ocultos');
  }

  return [...examples, ...hidden].map(([input, expected_output], ordinal) => ({
    ordinal,
    input,
    expected_output,
    is_example: ordinal < 2,
  }));
}

function originalProblem(
  slug: string,
  title: string,
  category: ProblemCategory,
  description: string,
  examples: readonly CaseIO[],
  hidden: readonly CaseIO[],
): SeedProblem {
  return {
    slug,
    title,
    category,
    description,
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    version: 1,
    origin: {
      kind: 'original',
      url: null,
      license: 'MIT',
      attribution: 'DueloDev Team',
      verification_status: 'verified',
    },
    test_cases: makeTestCases(examples, hidden),
  };
}

export const ADDITIONAL_PROBLEMS: readonly SeedProblem[] = [
  originalProblem(
    'contar-pares',
    'Conteo de números pares',
    'facil',
    `Dada una secuencia de enteros, cuenta cuántos son divisibles entre dos.

### Entrada
La primera línea contiene N (1 <= N <= 100000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime la cantidad de valores pares.`,
    [
      ['6\n1 2 3 4 5 6\n', '3\n'],
      ['5\n-2 -1 0 7 10\n', '3\n'],
    ],
    [
      ['1\n0\n', '1\n'],
      ['1\n-5\n', '0\n'],
      ['5\n1 3 5 7 9\n', '0\n'],
      ['5\n2 4 6 8 10\n', '5\n'],
      ['6\n-6 -4 -2 0 2 4\n', '6\n'],
      ['5\n-3 -2 -1 0 1\n', '2\n'],
      ['4\n1000000000 999999999 -1000000000 7\n', '2\n'],
      ['3\n-999999999 -999999998 999999998\n', '2\n'],
      ['8\n1 0 1 0 1 0 1 0\n', '4\n'],
      ['10\n12 14 16 18 20 22 24 26 28 30\n', '10\n'],
    ],
  ),
  originalProblem(
    'mayor-posicion',
    'Mayor valor y su posición',
    'facil',
    `Encuentra el mayor valor de una secuencia y su primera posición. Las posiciones empiezan en uno; si el máximo se repite, reporta la primera aparición.

### Entrada
La primera línea contiene N (1 <= N <= 100000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime el máximo y su posición, separados por un espacio.`,
    [
      ['5\n1 8 3 2 5\n', '8 2\n'],
      ['4\n-10 -3 -25 -7\n', '-3 2\n'],
    ],
    [
      ['1\n42\n', '42 1\n'],
      ['4\n5 5 5 5\n', '5 1\n'],
      ['4\n1 3 5 9\n', '9 4\n'],
      ['5\n1 100 3 100 2\n', '100 2\n'],
      ['5\n-9 -8 -7 -1 -3\n', '-1 4\n'],
      ['4\n-1000000 1000000 0 999999\n', '1000000 2\n'],
      ['10\n0 1 2 3 4 5 6 7 8 9\n', '9 10\n'],
      ['4\n99 2 3 4\n', '99 1\n'],
      ['3\n0 0 0\n', '0 1\n'],
      ['5\n1 -1000000 2 3 3\n', '3 4\n'],
    ],
  ),
  originalProblem(
    'reloj-segundos',
    'Duración en segundos',
    'facil',
    `Convierte una duración dada en horas, minutos y segundos a segundos totales. Las horas representan una duración y no se reinician al llegar a 24.

### Entrada
Una línea con H, M y S: H >= 0, 0 <= M < 60 y 0 <= S < 60.

### Salida
Imprime H * 3600 + M * 60 + S.`,
    [
      ['1 1 1\n', '3661\n'],
      ['2 0 0\n', '7200\n'],
    ],
    [
      ['0 0 0\n', '0\n'],
      ['0 0 59\n', '59\n'],
      ['0 1 0\n', '60\n'],
      ['0 59 59\n', '3599\n'],
      ['1 0 0\n', '3600\n'],
      ['23 59 59\n', '86399\n'],
      ['24 0 0\n', '86400\n'],
      ['100 1 1\n', '360061\n'],
      ['999 59 59\n', '3599999\n'],
      ['10 30 30\n', '37830\n'],
    ],
  ),
  originalProblem(
    'contar-vocales',
    'Contar vocales',
    'facil',
    `Cuenta las vocales a, e, i, o, u de una palabra en minúsculas. La letra y no se considera vocal.

### Entrada
Una palabra S de letras inglesas minúsculas (1 <= |S| <= 100000).

### Salida
Imprime la cantidad de vocales de S.`,
    [
      ['duelodev\n', '4\n'],
      ['programacion\n', '5\n'],
    ],
    [
      ['a\n', '1\n'],
      ['rhythm\n', '0\n'],
      ['aeiou\n', '5\n'],
      ['bcdfg\n', '0\n'],
      ['murcielago\n', '5\n'],
      ['computadora\n', '5\n'],
      ['ae\n', '2\n'],
      ['xxxy\n', '0\n'],
      ['bbbbbbba\n', '1\n'],
      ['programador\n', '4\n'],
    ],
  ),
  originalProblem(
    'valores-distintos',
    'Cantidad de valores distintos',
    'facil',
    `Determina cuántos valores diferentes aparecen en una secuencia de enteros.

### Entrada
La primera línea contiene N (1 <= N <= 100000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime la cantidad de valores distintos.`,
    [
      ['6\n1 2 2 3 3 3\n', '3\n'],
      ['5\n-1 0 -1 2 0\n', '3\n'],
    ],
    [
      ['1\n7\n', '1\n'],
      ['5\n4 4 4 4 4\n', '1\n'],
      ['5\n1 2 3 4 5\n', '5\n'],
      ['6\n0 0 1 1 2 2\n', '3\n'],
      ['4\n-3 -2 -1 0\n', '4\n'],
      ['7\n10 9 8 7 6 5 4\n', '7\n'],
      ['5\n1000000000 -1000000000 0 1000000000 0\n', '3\n'],
      ['8\n1 1 2 2 3 3 4 4\n', '4\n'],
      ['6\n-5 -5 -5 5 5 5\n', '2\n'],
      ['10\n1 2 3 1 2 3 1 2 3 1\n', '3\n'],
    ],
  ),
  originalProblem(
    'invertir-palabra',
    'Invertir una palabra',
    'facil',
    `Imprime una palabra en orden inverso.

### Entrada
Una palabra S formada por letras inglesas minúsculas (1 <= |S| <= 100000).

### Salida
Imprime S invertida.`,
    [
      ['duelodev\n', 'vedoleud\n'],
      ['anita\n', 'atina\n'],
    ],
    [
      ['a\n', 'a\n'],
      ['ab\n', 'ba\n'],
      ['aa\n', 'aa\n'],
      ['abcd\n', 'dcba\n'],
      ['level\n', 'level\n'],
      ['python\n', 'nohtyp\n'],
      ['racecar\n', 'racecar\n'],
      ['xyz\n', 'zyx\n'],
      ['abcc\n', 'ccba\n'],
      ['casa\n', 'asac\n'],
    ],
  ),
  originalProblem(
    'suma-digitos',
    'Suma de dígitos',
    'facil',
    `Calcula la suma de los dígitos decimales de un entero no negativo.

### Entrada
Una línea con N (0 <= N <= 10^18).

### Salida
Imprime la suma de sus dígitos.`,
    [
      ['12345\n', '15\n'],
      ['9080\n', '17\n'],
    ],
    [
      ['0\n', '0\n'],
      ['1\n', '1\n'],
      ['10\n', '1\n'],
      ['999\n', '27\n'],
      ['100000\n', '1\n'],
      ['123456789\n', '45\n'],
      ['1000000000000000000\n', '1\n'],
      ['909090\n', '27\n'],
      ['55555\n', '25\n'],
      ['123456789012345\n', '60\n'],
    ],
  ),
  originalProblem(
    'rotar-arreglo',
    'Rotar una secuencia a la izquierda',
    'facil',
    `Rota una secuencia K posiciones hacia la izquierda. Si K es mayor que N, aplica K módulo N.

### Entrada
La primera línea contiene N y K (1 <= N <= 100000, 0 <= K <= 10^9). La segunda contiene N enteros.

### Salida
Imprime la secuencia rotada en una línea, separada por espacios.`,
    [
      ['5 2\n1 2 3 4 5\n', '3 4 5 1 2\n'],
      ['4 6\n10 20 30 40\n', '30 40 10 20\n'],
    ],
    [
      ['1 0\n7\n', '7\n'],
      ['1 100\n-5\n', '-5\n'],
      ['5 0\n1 2 3 4 5\n', '1 2 3 4 5\n'],
      ['5 5\n1 2 3 4 5\n', '1 2 3 4 5\n'],
      ['4 1\n9 8 7 6\n', '8 7 6 9\n'],
      ['4 3\n9 8 7 6\n', '6 9 8 7\n'],
      ['6 8\n1 2 3 4 5 6\n', '3 4 5 6 1 2\n'],
      ['3 2\n-1 -2 -3\n', '-3 -1 -2\n'],
      ['5 4\n0 0 1 0 0\n', '0 0 0 1 0\n'],
      ['5 11\n1 1 1 2 2\n', '1 1 2 2 1\n'],
    ],
  ),
  originalProblem(
    'primer-suficiente',
    'Primera posición suficiente',
    'facil_medio',
    `Dado un arreglo ordenado y un objetivo X, encuentra la primera posición cuyo valor sea mayor o igual a X. Las posiciones empiezan en uno.

### Entrada
La primera línea contiene N y X (1 <= N <= 200000, -10^9 <= X <= 10^9).
La segunda contiene N enteros A[i] en orden no decreciente, con -10^9 <= A[i] <= 10^9.

### Salida
Imprime la primera posición que cumple la condición, o -1 si no existe.`,
    [
      ['5 6\n1 3 5 7 9\n', '4\n'],
      ['4 2\n2 2 2 5\n', '1\n'],
    ],
    [
      ['1 0\n0\n', '1\n'],
      ['1 5\n1\n', '-1\n'],
      ['3 0\n1 2 3\n', '1\n'],
      ['3 4\n1 2 3\n', '-1\n'],
      ['5 2\n1 2 2 2 4\n', '2\n'],
      ['4 -2\n-5 -1 0 3\n', '2\n'],
      ['4 1\n-5 -1 0 3\n', '4\n'],
      ['4 1\n1 1 1 1\n', '1\n'],
      ['3 11\n0 10 20\n', '3\n'],
      ['3 1000000000\n1000000000 1000000000 1000000001\n', '1\n'],
    ],
  ),
  originalProblem(
    'tramo-limitado',
    'Tramo más largo con suma limitada',
    'facil_medio',
    `Encuentra la longitud máxima de un tramo contiguo cuya suma no supere S. Todos los valores son no negativos, por lo que una ventana deslizante es suficiente.

### Entrada
La primera línea contiene N y S (1 <= N <= 200000, 0 <= S <= 10^15). La segunda contiene N enteros A[i] (0 <= A[i] <= 10^6).

### Salida
Imprime la longitud máxima.`,
    [
      ['6 4\n1 2 1 1 5 1\n', '3\n'],
      ['5 2\n0 0 2 0 1\n', '4\n'],
    ],
    [
      ['1 0\n0\n', '1\n'],
      ['1 0\n1\n', '0\n'],
      ['5 0\n0 0 0 0 0\n', '5\n'],
      ['4 3\n1 2 3 4\n', '2\n'],
      ['4 4\n2 2 2 2\n', '2\n'],
      ['4 3\n1 1 1 1\n', '3\n'],
      ['6 0\n4 0 1 0 0 2\n', '2\n'],
      ['4 0\n0 0 0 0\n', '4\n'],
      ['5 6\n2 2 2 2 2\n', '3\n'],
      ['4 1000000\n1000000 1 1 1000000\n', '2\n'],
    ],
  ),
  originalProblem(
    'camino-corto',
    'Camino más corto en una cuadrícula',
    'facil_medio',
    `Encuentra la menor cantidad de movimientos entre S y E. Desde cada celda sólo puedes moverte arriba, abajo, izquierda o derecha; # representa una pared y . una celda libre.

### Entrada
La primera línea contiene R y C (1 <= R, C <= 1000). Siguen R cadenas de longitud C con exactamente una S y una E.

### Salida
Imprime la distancia mínima en movimientos, o -1 si no hay camino.`,
    [
      ['3 4\nS..#\n.#..\n...E\n', '5\n'],
      ['3 3\nS#.\n.#.\n..E\n', '4\n'],
    ],
    [
      ['1 2\nSE\n', '1\n'],
      ['1 3\nS#E\n', '-1\n'],
      ['2 2\nS.\n.E\n', '2\n'],
      ['3 3\nS..\n...\n..E\n', '4\n'],
      ['3 3\nS##\n.##\n..E\n', '4\n'],
      ['3 3\nS..\n##.\n..E\n', '4\n'],
      ['2 3\nS.E\n...\n', '2\n'],
      ['4 4\nS...\n###.\nE...\n....\n', '8\n'],
      ['2 2\nS#\n#E\n', '-1\n'],
      ['3 4\nS...\n.##.\n...E\n', '5\n'],
    ],
  ),
  originalProblem(
    'agenda-compatible',
    'Máximo de actividades compatibles',
    'facil_medio',
    `Cada actividad ocupa un intervalo semiabierto [inicio, fin). Selecciona la mayor cantidad de actividades que una persona puede realizar, sin que se traslapen.

### Entrada
La primera línea contiene N (0 <= N <= 100000). Siguen N pares inicio fin con
-10^9 <= inicio < fin <= 10^9.

### Salida
Imprime la cantidad máxima de actividades compatibles.`,
    [
      ['5\n1 3\n2 5\n3 4\n4 6\n6 8\n', '4\n'],
      ['4\n0 5\n1 2\n2 3\n3 4\n', '3\n'],
    ],
    [
      ['0\n', '0\n'],
      ['1\n0 1\n', '1\n'],
      ['3\n1 10\n2 9\n3 8\n', '1\n'],
      ['3\n0 2\n2 4\n4 6\n', '3\n'],
      ['3\n1 3\n0 3\n2 3\n', '1\n'],
      ['4\n5 7\n1 2\n2 5\n8 9\n', '4\n'],
      ['4\n0 3\n2 4\n3 5\n4 7\n', '2\n'],
      ['3\n-5 -2\n-2 0\n1 2\n', '3\n'],
      ['4\n0 2\n1 3\n2 4\n3 5\n', '2\n'],
      ['5\n1 4\n2 3\n3 5\n5 7\n6 8\n', '3\n'],
    ],
  ),
  originalProblem(
    'par-objetivo',
    'Par con suma objetivo',
    'facil_medio',
    `Determina si dos posiciones distintas de un arreglo ordenado contienen valores cuya suma es T. Puedes elegir una posición como máximo una vez.

### Entrada
La primera línea contiene N y T (1 <= N <= 200000, -10^9 <= T <= 10^9).
La segunda contiene N enteros A[i] en orden no decreciente, con -10^9 <= A[i] <= 10^9.

### Salida
Imprime SI si existe el par, o NO en caso contrario.`,
    [
      ['5 9\n1 2 4 7 11\n', 'SI\n'],
      ['4 8\n1 2 3 9\n', 'NO\n'],
    ],
    [
      ['1 2\n1\n', 'NO\n'],
      ['2 2\n1 1\n', 'SI\n'],
      ['4 -7\n-5 -2 0 3\n', 'SI\n'],
      ['3 1\n0 0 0\n', 'NO\n'],
      ['4 -2\n-10 -4 2 8\n', 'SI\n'],
      ['4 7\n1 2 3 4\n', 'SI\n'],
      ['4 20\n1 2 3 4\n', 'NO\n'],
      ['2 2000000000\n1000000000 1000000000\n', 'SI\n'],
      ['4 4\n2 2 2 2\n', 'SI\n'],
      ['4 8\n1 3 5 7\n', 'SI\n'],
    ],
  ),
  originalProblem(
    'maximo-ventana',
    'Máxima suma de ventana fija',
    'facil_medio',
    `Encuentra la mayor suma de cualquier tramo contiguo de exactamente K elementos.

### Entrada
La primera línea contiene N y K (1 <= K <= N <= 200000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime la suma máxima.`,
    [
      ['5 3\n1 2 3 4 5\n', '12\n'],
      ['4 2\n-1 -2 -3 -4\n', '-3\n'],
    ],
    [
      ['1 1\n7\n', '7\n'],
      ['4 4\n1 2 3 4\n', '10\n'],
      ['5 2\n0 0 0 0 0\n', '0\n'],
      ['5 2\n-5 -1 -3 -2 -4\n', '-4\n'],
      ['6 3\n1 10 -2 4 5 6\n', '15\n'],
      ['5 1\n-2 8 3 8 -1\n', '8\n'],
      ['5 3\n5 -10 5 -10 5\n', '0\n'],
      ['4 2\n1000000 1000000 -1000000 1000000\n', '2000000\n'],
      ['6 4\n-1 -2 10 -1 -1 -1\n', '7\n'],
      ['5 3\n2 2 2 2 2\n', '6\n'],
    ],
  ),
  originalProblem(
    'suma-submatriz',
    'Consultas de suma en una matriz',
    'facil_medio',
    `Responde sumas de submatrices rectangulares. Las esquinas de cada consulta están incluidas y sus coordenadas empiezan en uno.

### Entrada
La primera línea contiene R, C y Q (1 <= R, C <= 1000, 1 <= Q <= 100000).
Siguen R filas de C enteros A[i][j] (-10^6 <= A[i][j] <= 10^6) y luego Q consultas r1 c1 r2 c2.
Las sumas caben en un entero de 64 bits.

### Salida
Imprime la suma de cada rectángulo en una línea.`,
    [
      ['2 3 2\n1 2 3\n4 5 6\n1 1 2 2\n1 2 2 3\n', '12\n16\n'],
      ['2 2 2\n-1 2\n3 -4\n1 1 2 2\n1 2 2 2\n', '0\n-2\n'],
    ],
    [
      ['1 1 1\n5\n1 1 1 1\n', '5\n'],
      ['1 3 3\n1 2 3\n1 1 1 1\n1 2 1 2\n1 3 1 3\n', '1\n2\n3\n'],
      ['2 2 2\n0 0\n0 0\n1 1 2 2\n1 2 2 2\n', '0\n0\n'],
      ['2 2 2\n1 2\n3 4\n1 1 1 2\n2 1 2 2\n', '3\n7\n'],
      ['3 3 1\n1 2 3\n4 5 6\n7 8 9\n2 2 2 2\n', '5\n'],
      ['3 2 2\n1 2\n3 4\n5 6\n1 1 3 1\n1 2 3 2\n', '9\n12\n'],
      ['2 2 1\n-1 -2\n-3 -4\n1 1 2 2\n', '-10\n'],
      ['2 3 2\n0 0 0\n4 5 6\n2 1 2 3\n1 1 1 3\n', '15\n0\n'],
      ['3 2 2\n1 10\n2 20\n3 30\n1 1 3 2\n2 2 3 2\n', '66\n50\n'],
      ['3 3 3\n1 1 1\n1 1 1\n1 1 1\n1 1 3 3\n2 2 2 2\n2 2 3 3\n', '9\n1\n4\n'],
    ],
  ),
  originalProblem(
    'racha-consecutiva',
    'Racha consecutiva más larga',
    'facil_medio',
    `Encuentra la longitud de la racha de enteros consecutivos más larga que pueda formarse con los valores del arreglo, sin exigir que aparezcan juntos ni ordenados. Los duplicados cuentan una sola vez.

### Entrada
La primera línea contiene N (1 <= N <= 200000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime la longitud de la racha más larga.`,
    [
      ['6\n100 4 200 1 3 2\n', '4\n'],
      ['5\n1 2 2 3 5\n', '3\n'],
    ],
    [
      ['1\n7\n', '1\n'],
      ['3\n1 1 1\n', '1\n'],
      ['3\n1 3 5\n', '1\n'],
      ['4\n-3 -2 -1 0\n', '4\n'],
      ['4\n10 11 12 14\n', '3\n'],
      ['5\n5 4 3 2 1\n', '5\n'],
      ['3\n-1000000 999999 1000000\n', '2\n'],
      ['6\n0 2 1 4 3 7\n', '5\n'],
      ['5\n8 2 6 4 10\n', '1\n'],
      ['10\n1 2 3 4 5 6 7 8 9 10\n', '10\n'],
    ],
  ),
  originalProblem(
    'cambio-minimo',
    'Cambio mínimo',
    'dificil',
    `Calcula el mínimo número de monedas necesarias para formar exactamente M usando cualquier cantidad de monedas de las denominaciones dadas. Si no es posible, imprime -1.

### Entrada
La primera línea contiene M y C (0 <= M <= 100000, 1 <= C <= 100). La segunda contiene C denominaciones positivas, cada una no mayor que 100000.

### Salida
Imprime el mínimo número de monedas, o -1 si no existe una combinación válida.`,
    [
      ['11 3\n1 5 7\n', '3\n'],
      ['6 2\n4 3\n', '2\n'],
    ],
    [
      ['0 3\n1 2 5\n', '0\n'],
      ['1 1\n1\n', '1\n'],
      ['2 1\n3\n', '-1\n'],
      ['7 2\n2 4\n', '-1\n'],
      ['10 1\n1\n', '10\n'],
      ['10 2\n2 3\n', '4\n'],
      ['8 2\n3 4\n', '2\n'],
      ['9 2\n2 5\n', '3\n'],
      ['13 3\n1 5 10\n', '4\n'],
      ['20 2\n3 7\n', '4\n'],
    ],
  ),
  originalProblem(
    'mochila-01',
    'Mochila de capacidad limitada',
    'dificil',
    `Cada objeto puede elegirse como máximo una vez. Encuentra el valor máximo que puedes llevar sin superar la capacidad W.

### Entrada
La primera línea contiene N y W (1 <= N <= 100, 0 <= W <= 10000).
Siguen N líneas con peso w y valor v (1 <= w <= 10000, 1 <= v <= 10^9).
La suma de valores cabe en un entero de 64 bits.

### Salida
Imprime el valor máximo alcanzable.`,
    [
      ['3 5\n2 3\n3 4\n4 5\n', '7\n'],
      ['4 7\n1 1\n3 4\n4 5\n5 7\n', '9\n'],
    ],
    [
      ['1 5\n5 7\n', '7\n'],
      ['1 4\n5 7\n', '0\n'],
      ['2 3\n2 3\n2 3\n', '3\n'],
      ['3 5\n2 3\n3 4\n4 5\n', '7\n'],
      ['3 5\n1 6\n2 10\n3 12\n', '22\n'],
      ['4 10\n6 30\n3 14\n4 16\n2 9\n', '46\n'],
      ['2 10\n10 100\n1 1\n', '100\n'],
      ['4 8\n2 4\n3 5\n4 7\n5 8\n', '13\n'],
      ['3 7\n5 10\n4 40\n6 30\n', '40\n'],
      ['4 12\n5 10\n4 40\n6 30\n3 50\n', '100\n'],
    ],
  ),
  originalProblem(
    'subsecuencia-comun',
    'Subsecuencia común más larga',
    'dificil',
    `Calcula la longitud de la subsecuencia común más larga de dos cadenas. Una subsecuencia conserva el orden de los caracteres, pero no necesita ser contigua.

### Entrada
Dos líneas con cadenas de letras inglesas (0 <= longitud <= 1000).

### Salida
Imprime la longitud de la subsecuencia común más larga.`,
    [
      ['ABCBDAB\nBDCABA\n', '4\n'],
      ['abc\nabc\n', '3\n'],
    ],
    [
      ['a\nb\n', '0\n'],
      ['a\na\n', '1\n'],
      ['aaaa\naa\n', '2\n'],
      ['abc\ndef\n', '0\n'],
      ['AGGTAB\nGXTXAYB\n', '4\n'],
      ['abcdef\nace\n', '3\n'],
      ['abcbdab\nbdcaba\n', '4\n'],
      ['x\nxxxx\n', '1\n'],
      ['XMJYAUZ\nMZJAWXU\n', '4\n'],
      ['azbycx\nabcxyz\n', '4\n'],
    ],
  ),
  originalProblem(
    'camino-minimo',
    'Camino mínimo con pesos',
    'dificil',
    `Encuentra el costo mínimo entre dos vértices de un grafo no dirigido con pesos no negativos. Puede haber aristas paralelas.

### Entrada
La primera línea contiene N, M, S y T (1 <= N <= 100000, 0 <= M <= 200000, 1 <= S, T <= N).
Siguen M aristas U V W (1 <= U, V <= N, 0 <= W <= 10^9).
La respuesta cabe en un entero de 64 bits.

### Salida
Imprime el costo mínimo o -1 si T es inalcanzable desde S.`,
    [
      ['4 4 1 4\n1 2 2\n2 4 3\n1 3 1\n3 4 10\n', '5\n'],
      ['3 1 1 3\n1 2 8\n', '-1\n'],
    ],
    [
      ['1 0 1 1\n', '0\n'],
      ['2 1 1 2\n1 2 5\n', '5\n'],
      ['3 2 1 3\n1 2 1\n2 3 2\n', '3\n'],
      ['4 5 1 4\n1 4 10\n1 2 2\n2 4 3\n1 3 1\n3 4 4\n', '5\n'],
      ['4 2 1 4\n1 2 1\n3 4 1\n', '-1\n'],
      ['3 3 1 3\n1 2 0\n2 3 4\n1 3 10\n', '4\n'],
      ['2 2 1 2\n1 2 9\n1 2 2\n', '2\n'],
      ['5 5 1 5\n1 2 2\n2 3 2\n3 4 2\n1 4 10\n4 5 1\n', '7\n'],
      ['3 2 1 3\n1 2 1000000000\n2 3 1000000000\n', '2000000000\n'],
      ['4 5 1 4\n1 2 5\n2 3 5\n1 3 20\n3 4 1\n2 4 10\n', '11\n'],
    ],
  ),
  originalProblem(
    'escaleras',
    'Formas de subir escaleras',
    'dificil',
    `Cuenta de cuántas formas distintas se puede llegar al escalón N avanzando 1, 2 o 3 escalones en cada movimiento. El orden de los movimientos sí distingue una forma. Usa módulo 1000000007.

### Entrada
Una línea con N (0 <= N <= 1000000). En N = 0 existe una forma: no realizar movimientos.

### Salida
Imprime la cantidad de formas módulo 1000000007.`,
    [
      ['4\n', '7\n'],
      ['7\n', '44\n'],
    ],
    [
      ['0\n', '1\n'],
      ['1\n', '1\n'],
      ['2\n', '2\n'],
      ['3\n', '4\n'],
      ['5\n', '13\n'],
      ['6\n', '24\n'],
      ['8\n', '81\n'],
      ['9\n', '149\n'],
      ['10\n', '274\n'],
      ['12\n', '927\n'],
    ],
  ),
  originalProblem(
    'orden-topologico',
    'Orden topológico mínimo',
    'dificil',
    `Imprime el orden topológico lexicográficamente menor de un grafo dirigido. Si el grafo contiene un ciclo, no existe tal orden.

### Entrada
La primera línea contiene N y M (1 <= N <= 100000, 0 <= M <= 200000).
Siguen M aristas dirigidas U V (1 <= U, V <= N). Puede haber aristas repetidas.

### Salida
Imprime los N vértices del orden separados por espacios, o IMPOSIBLE si hay un ciclo.`,
    [
      ['4 3\n1 2\n1 3\n3 4\n', '1 2 3 4\n'],
      ['3 3\n1 2\n2 3\n3 1\n', 'IMPOSIBLE\n'],
    ],
    [
      ['1 0\n', '1\n'],
      ['4 0\n', '1 2 3 4\n'],
      ['2 1\n2 1\n', '2 1\n'],
      ['4 2\n1 3\n2 3\n', '1 2 3 4\n'],
      ['3 1\n1 2\n', '1 2 3\n'],
      ['3 3\n1 2\n2 3\n3 1\n', 'IMPOSIBLE\n'],
      ['4 3\n1 2\n2 3\n3 4\n', '1 2 3 4\n'],
      ['4 3\n3 1\n3 2\n4 2\n', '3 1 4 2\n'],
      ['5 2\n2 4\n1 4\n', '1 2 3 4 5\n'],
      ['4 4\n1 2\n1 3\n2 4\n3 4\n', '1 2 3 4\n'],
    ],
  ),
  originalProblem(
    'cuadrado-unos',
    'Cuadrado máximo de unos',
    'dificil',
    `Encuentra la longitud del lado del mayor subcuadrado formado exclusivamente por unos en una matriz binaria.

### Entrada
La primera línea contiene R y C (1 <= R, C <= 1000). Siguen R cadenas de C caracteres, cada uno 0 o 1.

### Salida
Imprime la longitud del lado máximo. Si no existe ningún 1, imprime 0.`,
    [
      ['3 4\n1111\n1111\n0111\n', '3\n'],
      ['3 3\n110\n110\n001\n', '2\n'],
    ],
    [
      ['1 1\n1\n', '1\n'],
      ['1 1\n0\n', '0\n'],
      ['2 2\n11\n11\n', '2\n'],
      ['2 3\n101\n111\n', '1\n'],
      ['3 3\n000\n000\n000\n', '0\n'],
      ['3 3\n100\n010\n001\n', '1\n'],
      ['3 3\n111\n111\n111\n', '3\n'],
      ['4 4\n1111\n1111\n1111\n0000\n', '3\n'],
      ['2 4\n1111\n1111\n', '2\n'],
      ['4 2\n11\n11\n11\n11\n', '2\n'],
    ],
  ),
  originalProblem(
    'subsecuencia-creciente',
    'Subsecuencia estrictamente creciente',
    'dificil',
    `Calcula la longitud de la subsecuencia estrictamente creciente más larga. Sus elementos conservan el orden original, pero no necesitan estar contiguos.

### Entrada
La primera línea contiene N (1 <= N <= 200000). La segunda contiene N enteros A[i] (-10^9 <= A[i] <= 10^9).

### Salida
Imprime la longitud máxima.`,
    [
      ['8\n10 9 2 5 3 7 101 18\n', '4\n'],
      ['4\n1 2 2 3\n', '3\n'],
    ],
    [
      ['1\n7\n', '1\n'],
      ['5\n5 4 3 2 1\n', '1\n'],
      ['5\n1 2 3 4 5\n', '5\n'],
      ['3\n1 1 1\n', '1\n'],
      ['4\n-3 -2 -1 0\n', '4\n'],
      ['5\n3 1 2 2 4\n', '3\n'],
      ['6\n5 1 6 2 3 4\n', '4\n'],
      ['7\n7 2 3 1 4 5 6\n', '5\n'],
      ['5\n10 4 3 8 9\n', '3\n'],
      ['5\n-5 -4 -3 -2 -1\n', '5\n'],
    ],
  ),
  originalProblem(
    'reparto-cargas',
    'Reparto de tareas en grupos',
    'dificil',
    `Divide la secuencia de tareas contiguas en como máximo K grupos no vacíos. Minimiza la mayor suma de un grupo; todas las duraciones son no negativas.

### Entrada
La primera línea contiene N y K (1 <= K <= N <= 200000).
La segunda contiene N enteros no negativos A[i] (0 <= A[i] <= 10^9).
La suma total cabe en un entero de 64 bits.

### Salida
Imprime el menor valor posible de la suma máxima de un grupo.`,
    [
      ['5 3\n1 2 3 4 5\n', '6\n'],
      ['4 2\n7 2 5 10\n', '14\n'],
    ],
    [
      ['1 1\n5\n', '5\n'],
      ['4 4\n1 2 3 4\n', '4\n'],
      ['4 1\n1 2 3 4\n', '10\n'],
      ['3 2\n4 4 4\n', '8\n'],
      ['5 3\n0 0 0 0 0\n', '0\n'],
      ['6 3\n2 2 2 2 2 2\n', '4\n'],
      ['5 2\n10 1 1 1 1\n', '10\n'],
      ['5 2\n1 2 3 4 5\n', '9\n'],
      ['3 2\n100 1 1\n', '100\n'],
      ['5 3\n10 20 30 40 50\n', '60\n'],
    ],
  ),
  originalProblem(
    'componentes-grafo',
    'Componentes conexas',
    'dificil',
    `Cuenta los componentes conexos de un grafo no dirigido. Los vértices aislados también cuentan como componentes.

### Entrada
La primera línea contiene N y M (1 <= N <= 200000, 0 <= M <= 200000).
Siguen M aristas U V (1 <= U, V <= N). Puede haber aristas repetidas.

### Salida
Imprime el número de componentes conexas.`,
    [
      ['5 3\n1 2\n2 3\n4 5\n', '2\n'],
      ['4 3\n1 2\n2 3\n3 1\n', '2\n'],
    ],
    [
      ['1 0\n', '1\n'],
      ['5 0\n', '5\n'],
      ['2 1\n1 2\n', '1\n'],
      ['4 3\n1 2\n2 3\n3 4\n', '1\n'],
      ['4 2\n1 2\n3 4\n', '2\n'],
      ['6 2\n1 2\n2 3\n', '4\n'],
      ['5 4\n1 2\n2 3\n3 1\n4 5\n', '2\n'],
      ['3 3\n1 2\n2 3\n3 1\n', '1\n'],
      ['5 4\n1 2\n2 3\n3 4\n4 5\n', '1\n'],
      ['7 4\n1 2\n2 3\n4 5\n6 7\n', '3\n'],
    ],
  ),
];
