export function copyCoefficientMajorRgbToChannelMajor(
    source, sourceOffset, destination, destinationOffset, coefficientCount
) {
    for (let coefficient = 0; coefficient < coefficientCount; coefficient++) {
        for (let channel = 0; channel < 3; channel++) {
            destination[destinationOffset + channel * coefficientCount + coefficient] =
                source[sourceOffset + coefficient * 3 + channel];
        }
    }
}
