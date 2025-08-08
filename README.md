# f1-api-ws

Este proyecto es un backend que actúa como un espejo de WebSocket para datos de Fórmula 1. La funcionalidad principal consiste en conectarse a un WebSocket fuente de datos de F1, almacenar la información recibida en variables internas, y luego retransmitir estos datos a los clientes que se conectan a nuestro propio WebSocket.

## Descripción general

- **Entrada:** Datos provenientes de un WebSocket de terceros (por ejemplo, el feed oficial o no oficial de Fórmula 1).
- **Procesamiento:** Los datos recibidos se almacenan y actualizan en variables internas usando una lógica de fusión profunda (`deepMerge`), permitiendo actualizar solo las partes relevantes de la estructura de datos sin sobrescribir completamente el estado anterior.
- **Salida:** Los datos actualizados se ponen a disposición de los oyentes/clientes que se conectan a este backend vía WebSocket.

---

## ¿Cómo se almacena la información?

Cada vez que se recibe un mensaje del WebSocket de Fórmula 1, no se reemplaza completamente la variable que contiene el estado de la información, sino que se realiza una **fusión profunda** (“deep merge”). Esto permite:

- Conservar los valores ya recibidos anteriormente que no hayan cambiado.
- Actualizar solo las partes del objeto que hayan sido modificadas en el nuevo mensaje.
- Evitar la pérdida de información parcial si los eventos/mensajes son incrementales.

### Ejemplo de `deepMerge`

Supón que tienes el siguiente estado almacenado:

```js
let estado = {
  carData: {
    car1: { speed: 320, rpm: 12000 },
    car2: { speed: 315, rpm: 11800 }
  },
  weather: { temp: 28 }
};
```

Y recibes un nuevo mensaje solo con información actualizada del auto 1:

```js
let incoming = {
  carData: {
    car1: { speed: 325 }
  }
};
```

Usando `deepMerge(estado, incoming)`, el resultado sería:

```js
{
  carData: {
    car1: { speed: 325, rpm: 12000 },
    car2: { speed: 315, rpm: 11800 }
  },
  weather: { temp: 28 }
}
```

De esta forma, la información que no se incluyó en el mensaje entrante (por ejemplo, `rpm` de `car1`) se conserva.

---

## Función `deepMerge`

La función `deepMerge` es clave en el almacenamiento eficiente de la información. Su objetivo es combinar de manera recursiva los objetos, manteniendo los valores anteriores si no han sido sobrescritos.

### Ejemplo básico de implementación

```js
function deepMerge(target, source) {
  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
```

Esta función asegura que los objetos anidados se actualicen correctamente y que no se pierda información.

---
